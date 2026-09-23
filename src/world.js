import * as THREE from 'three';
import { CONFIG } from './config.js';

// ============================================================================
// World: Three.js scene, lighting, environment, characters, camera, render loop.
// ============================================================================

const QUEUE_DIR = new THREE.Vector3(0, 0, 1); // queue extends along +Z away from cashier
const QUEUE_SPACING = 1.25;                   // metres between queue spots
const CASHIER_X = -2.4;                       // counter front edge
const QUEUE_FRONT_Z = -1.0;                   // first queue position (just in front of counter)

// Active cashier counter footprint (x/z, world) — dropped groceries are kept
// out of it. Matches the counter top built in _buildCashierStation(0, true).
const COUNTER_BOX = {
  minX: CASHIER_X - 1.25, maxX: CASHIER_X + 1.25,
  minZ: -0.4 - 0.85,      maxZ: -0.4 + 0.85,
  topY: 1.07,
};

// Player "plumbob" marker (Sims-style floating diamond above the head).
const PLUMBOB_CALM  = new THREE.Color(0x35ff4d); // Sims green — normal state
const PLUMBOB_ALARM = new THREE.Color(0xff3b5c); // alarm red — setPlayerAlert(1)
const PLUMBOB_HOVER = 0.38;                      // gap above the top of the head (m)
const PLUMBOB_SPIN  = 1.2;                       // rad/s around Y

// 'kneel' gesture: forward bend at the hips + knee bend (leg squash).
const KNEEL_TILT       = 0.68; // ≈39° torso pitch at full crouch
const KNEEL_LEG_SQUASH = 0.36; // legs compress to 64% height → hips drop ≈0.24 m
const KNEEL_RAMP       = 0.12; // fraction of the duration spent easing in / out

export class World {
  constructor(canvas) {
    this.canvas = canvas;

    // ---- renderer ----
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // ---- scene + fog ----
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0c1230);
    this.scene.fog = new THREE.Fog(0x0c1230, 12, 38);

    // ---- camera ----
    this.camera = new THREE.PerspectiveCamera(
      45,
      window.innerWidth / window.innerHeight,
      0.1,
      100
    );
    // Camera framing: focus the corridor "player → cashier"; NPCs further back
    // than the player are deliberately framed out of view.
    this.cameraBase = new THREE.Vector3(5.0, 0.4, 7.5);    // Starts low for a cinematic rising reveal
    this.cameraTarget = new THREE.Vector3(-0.6, 0.4, 2.0);  // Looking forward/slightly up
    this.cameraOffset = new THREE.Vector3(5.6, 4.4, 5.5); // base = focus + offset
    this.camera.position.copy(this.cameraBase);
    this.camera.lookAt(this.cameraTarget);

    // ---- mountable groups ----
    this.charGroup = new THREE.Group();
    this.scene.add(this.charGroup);

    this.characterMap = new Map(); // id -> THREE.Group

    // animation timing
    this.clock = new THREE.Clock();
    this.shake = 0; // in [0,1]

    // post-conveyor scan animation refs
    this.scanItems = [];

    // dropped grocery items (DROP event) — physics + recovery animation
    this.droppedItems = [];

    // player marker alert level in [0,1] (see setPlayerAlert)
    this.playerAlert = 0;

    this._buildLights();
    this._buildEnvironment();
    this._buildPlumbob();

    window.addEventListener('resize', () => this._onResize());
  }

  // -----------------------------------------------------------------------
  // Lighting: hemisphere ambient + key directional (sunlight equivalent) +
  // ceiling fluorescents over the queue + warm spot on the cashier.
  // -----------------------------------------------------------------------
  _buildLights() {
    const hemi = new THREE.HemisphereLight(0xb6c7ff, 0x342515, 0.55);
    hemi.position.set(0, 10, 0);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffeed0, 1.4);
    key.position.set(8, 14, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 40;
    key.shadow.camera.left = -12;
    key.shadow.camera.right = 12;
    key.shadow.camera.top = 12;
    key.shadow.camera.bottom = -12;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);

    // ceiling fluorescent strips (visual + soft point lights)
    for (let i = -1; i <= 2; i++) {
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(3.0, 0.12, 0.5),
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          emissive: 0xffe9b5,
          emissiveIntensity: 1.2,
          metalness: 0.1,
          roughness: 0.4,
        })
      );
      strip.position.set(0, 4.6, i * 2.2);
      this.scene.add(strip);

      const pt = new THREE.PointLight(0xffe6b8, 0.45, 8, 1.4);
      pt.position.set(0, 4.4, i * 2.2);
      this.scene.add(pt);
    }

    // cashier warm spot
    const spot = new THREE.SpotLight(0xfff1c9, 1.2, 14, Math.PI * 0.18, 0.45, 1.4);
    spot.position.set(CASHIER_X - 0.4, 5.0, -1.2);
    spot.target.position.set(CASHIER_X - 0.4, 1.0, -1.2);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    this.scene.add(spot);
    this.scene.add(spot.target);
  }

  // -----------------------------------------------------------------------
  // Environment: floor, back wall, shelves with colorful product blocks,
  // cashier counter, register, conveyor belt, bagging area.
  // -----------------------------------------------------------------------
  _buildEnvironment() {
    // ---- floor (procedural tile texture) ----
    const tex = makeTileTexture();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(12, 12);
    tex.colorSpace = THREE.SRGBColorSpace;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.85,
        metalness: 0.05,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // ---- back wall ----
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0xe9e1cf, roughness: 0.9, metalness: 0.0,
    });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(40, 8), wallMat);
    wall.position.set(0, 4, -6);
    wall.receiveShadow = true;
    this.scene.add(wall);

    // ---- ceiling ----
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: 0xd9d2c0, roughness: 1.0 })
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = 5.0;
    this.scene.add(ceiling);

    // ---- "FRESH MARKET" sign on back wall ----
    const signTex = makeSignTexture('FRESH · MARKET');
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(7, 1.2),
      new THREE.MeshBasicMaterial({ map: signTex, transparent: true })
    );
    sign.position.set(0, 5.6, -5.99);
    this.scene.add(sign);

    // ---- shelves with product blocks ----
    this._buildShelves();

    // ---- cashier counter (cluster of meshes) ----
    this._buildCashierStation(0, true);
    this._buildCashierStation(-5.5, false);
    this._buildCashierStation(5.5, false);
    this._buildBackgroundQueues();

    // ---- ambient background shoppers (depth + atmosphere) ----
    this._buildAmbientNPCs();
  }

  _buildAmbientNPCs() {
    this.ambientNPCs = [];
    const homes = [
      { x: -7.5, z: -4.5 }, { x: -3.0, z: -5.2 },
      { x:  4.0, z: -4.7 }, { x:  7.5, z: -4.0 },
      { x: -5.5, z: -3.4 },
    ];
    const ageOptions   = ['Adult', 'Adult', 'Adult', 'Elderly', 'Youth'];
    const stateOptions = ['Standard', 'Standard', 'Standard', 'BusyParent', 'Pregnant'];
    for (const home of homes) {
      const state = pick(stateOptions);
      const profile = {
        id: 'amb_' + Math.random().toString(36).slice(2, 9),
        age: pick(ageOptions),
        state,
        label: 'Shopper',
        gender: state === 'Pregnant' ? 'F' : (Math.random() < 0.5 ? 'M' : 'F'),
        isPlayer: false,
      };
      const mesh = buildCharacter(profile);
      mesh.position.set(home.x, 0, home.z);
      mesh.rotation.y = Math.random() * Math.PI * 2;
      // Drop shadows for performance — they're far back and barely contribute.
      mesh.traverse((c) => { if (c.isMesh) c.castShadow = false; });
      this.scene.add(mesh);
      this.ambientNPCs.push({
        mesh,
        home,
        target: new THREE.Vector3(home.x, 0, home.z),
        nextRetargetMs: performance.now() + 1500 + Math.random() * 4000,
        bobPhase: Math.random() * Math.PI * 2,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Player marker: a Sims-style "plumbob" diamond floating above the
  // player's head. It lives directly in the scene (NOT inside the character
  // group) so gestures that tilt / squash / lower the character never tilt
  // it — _updatePlumbob re-anchors it to the head's world position per frame.
  // -----------------------------------------------------------------------
  _buildPlumbob() {
    // Two elongated pyramids point to point, ≈1:2.5 wide:tall like the Sims
    // one. Flat shading keeps the facets crisp; the clearcoat gives the
    // glassy glint as it spins, and a modest emissive keeps it readable in
    // shadow without flattening the facets into a solid green blob.
    const geo = new THREE.OctahedronGeometry(1, 0);
    geo.scale(0.085, 0.23, 0.085); // 0.17 wide × 0.46 tall
    const mat = new THREE.MeshPhysicalMaterial({
      color: PLUMBOB_CALM.clone(),
      emissive: PLUMBOB_CALM.clone(),
      emissiveIntensity: 0.3,
      roughness: 0.08,
      metalness: 0.15,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      flatShading: true,
      transparent: true,
      opacity: 0.96,
    });
    const pb = new THREE.Mesh(geo, mat);
    pb.castShadow = false;
    pb.receiveShadow = false;
    pb.visible = false; // shown once a PLAYER character exists
    this.scene.add(pb);
    this.plumbob = pb;

    this._plumbobAlert = 0;       // smoothed alert level actually displayed
    this._plumbobPulsePhase = 0;  // accumulated so frequency changes don't jump
    this._plumbobPresence = 0;    // 0..1 grow-in / shrink-out when player appears / leaves
    this._plumbobAnchor = new THREE.Vector3(); // last known top-of-head position
  }

  /**
   * Player marker alarm level, 0..1 (clamped; non-numbers → 0). 0 = calm
   * green plumbob. >0 blends the colour toward alarm red proportionally and
   * pulses brightness + size at a rate rising with level (≈1.5 Hz at 0.2 →
   * 5 Hz at 1.0). Only stores the value — cheap and idempotent, safe to call
   * every game tick; the visual eases toward it in update().
   */
  setPlayerAlert(level) {
    const v = Number(level);
    this.playerAlert = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  }

  _updatePlumbob(dtSec, t) {
    const pb = this.plumbob;
    if (!pb) return;
    const player = this.characterMap.get('PLAYER');

    // Grow in when the player appears; shrink out (at its last position)
    // once the player mesh is removed after checkout.
    const presenceTarget = player ? 1 : 0;
    this._plumbobPresence += (presenceTarget - this._plumbobPresence) * Math.min(1, dtSec * 6);
    if (!player && this._plumbobPresence < 0.01) {
      this._plumbobPresence = 0;
      pb.visible = false;
      return;
    }

    if (player) {
      const head = player.userData.headMesh;
      if (head) {
        // World position of the actual head (includes gestures + elderly stoop).
        head.getWorldPosition(this._plumbobAnchor);
        this._plumbobAnchor.y += player.userData.headTopOffset ?? 0.2;
      } else {
        this._plumbobAnchor.copy(player.position);
        this._plumbobAnchor.y += 1.9;
      }
    }

    pb.visible = true;
    pb.position.copy(this._plumbobAnchor);
    pb.position.y += PLUMBOB_HOVER + Math.sin(t * 2.2) * 0.03;
    // Always perfectly upright: only yaw, set absolutely each frame.
    pb.rotation.set(0, (t * PLUMBOB_SPIN) % (Math.PI * 2), 0);

    // Alert: ease toward the requested level so step changes don't pop.
    this._plumbobAlert += (this.playerAlert - this._plumbobAlert) * Math.min(1, dtSec * 5);
    if (this._plumbobAlert < 0.001) this._plumbobAlert = 0;
    const a = this._plumbobAlert;
    const freqHz = 0.625 + 4.375 * a; // 1.5 Hz @ 0.2 → 5 Hz @ 1.0
    this._plumbobPulsePhase = (this._plumbobPulsePhase + dtSec * freqHz * Math.PI * 2) % (Math.PI * 2);
    const pulse = 0.5 + 0.5 * Math.sin(this._plumbobPulsePhase); // 0..1

    const mat = pb.material;
    mat.color.copy(PLUMBOB_CALM).lerp(PLUMBOB_ALARM, a);
    mat.emissive.copy(mat.color);
    mat.emissiveIntensity = 0.3 + a * (0.6 + 1.2 * pulse);
    pb.scale.setScalar(this._plumbobPresence * (1 + a * 0.28 * pulse));
  }

  _buildShelves() {
    const shelfMat = new THREE.MeshStandardMaterial({ color: 0xb6a98b, roughness: 0.85 });
    const colors = [0xff6b6b, 0xffd166, 0x06d6a0, 0x118ab2, 0xef476f, 0xa663cc, 0x90be6d];

    for (let row = 0; row < 2; row++) {
      const z = -5.5;
      const x = row === 0 ? -8 : 5;
      const shelfGroup = new THREE.Group();

      for (let s = 0; s < 3; s++) {
        const shelf = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.12, 0.8), shelfMat);
        shelf.position.set(0, 1.0 + s * 1.0, 0);
        shelf.castShadow = shelf.receiveShadow = true;
        shelfGroup.add(shelf);

        for (let p = 0; p < 6; p++) {
          const c = colors[(row * 11 + s * 3 + p) % colors.length];
          const item = new THREE.Mesh(
            new THREE.BoxGeometry(0.35 + Math.random() * 0.1, 0.55, 0.3),
            new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 })
          );
          item.position.set(-1.5 + p * 0.55, 1.35 + s * 1.0, 0);
          item.castShadow = true;
          shelfGroup.add(item);
        }
      }
      shelfGroup.position.set(x, 0, z);
      this.scene.add(shelfGroup);
    }
  }

  _buildCashierStation(offsetX = 0, isActive = true) {
    const group = new THREE.Group();

    // counter base
    const counterMat = new THREE.MeshStandardMaterial({
      color: 0x37406b, roughness: 0.55, metalness: 0.15,
    });
    const counter = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.0, 1.6), counterMat);
    counter.position.set(0, 0.5, 0);
    counter.castShadow = counter.receiveShadow = true;
    group.add(counter);

    // counter top (lighter)
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(2.5, 0.06, 1.7),
      new THREE.MeshStandardMaterial({ color: 0x8a93c0, roughness: 0.4, metalness: 0.3 })
    );
    top.position.set(0, 1.04, 0);
    top.castShadow = top.receiveShadow = true;
    group.add(top);

    // conveyor belt slot
    const belt = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 0.05, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x1a1d35, roughness: 0.95 })
    );
    belt.position.set(0, 1.07, 0.45);
    group.add(belt);
    if (isActive) this.beltMesh = belt;

    // register / monitor
    const register = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.5, 0.45),
      new THREE.MeshStandardMaterial({ color: 0x2a2f5a, roughness: 0.6 })
    );
    register.position.set(0.7, 1.35, -0.4);
    register.castShadow = true;
    group.add(register);

    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.32),
      new THREE.MeshStandardMaterial({
        color: 0x000000,
        emissive: 0x29d4c4,
        emissiveIntensity: 0.9,
        roughness: 0.2,
      })
    );
    screen.position.set(0.7, 1.4, -0.18);
    group.add(screen);

    // scanner laser
    const scanner = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.04, 0.18),
      new THREE.MeshStandardMaterial({
        color: 0xff5c7a,
        emissive: 0xff5c7a,
        emissiveIntensity: 1.2,
      })
    );
    scanner.position.set(-0.5, 1.10, 0.2);
    group.add(scanner);
    if (isActive) this.scannerMesh = scanner;

    // bagging station (a couple of shopping bags)
    for (let i = 0; i < 2; i++) {
      const bag = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.4, 0.3),
        new THREE.MeshStandardMaterial({ color: 0xc7b083, roughness: 0.85 })
      );
      bag.position.set(-0.9 + i * 0.35, 1.27, -0.4);
      bag.castShadow = true;
      group.add(bag);
    }

    // cashier NPC behind the counter
    const cashier = buildCharacter({
      age: 'Adult',
      state: 'Cashier',
      isPlayer: false,
    });
    cashier.position.set(0, 0, -0.95);
    cashier.rotation.y = 0;
    group.add(cashier);

    if (!isActive) {
      group.traverse((c) => {
        if (c.isMesh && c.material) {
          c.material = c.material.clone();
          if (c.material.color) c.material.color.multiplyScalar(0.7);
          if (c.material.emissive) c.material.emissive.multiplyScalar(0.5);
        }
      });
      if (!this.backgroundNPCs) this.backgroundNPCs = [];
      this.backgroundNPCs.push({
        mesh: cashier,
        bobPhase: Math.random() * Math.PI * 2,
        isCashier: true
      });
    }

    group.position.set(CASHIER_X + offsetX, 0, -0.4);
    this.scene.add(group);
    
    if (isActive) {
      this.cashierGroup = group;
      this.cashierMesh = cashier;
    }
  }

  _buildBackgroundQueues() {
    if (!this.backgroundNPCs) this.backgroundNPCs = [];
    const offsets = [-5.5, 5.5];
    const ageOptions = ['Adult', 'Adult', 'Adult', 'Elderly', 'Youth'];
    const stateOptions = ['Standard', 'Standard', 'Pregnant', 'Standard'];
    
    offsets.forEach(offsetX => {
      const queueLen = 3 + Math.floor(Math.random() * 2);
      for (let i = 0; i < queueLen; i++) {
        const profile = {
          id: 'bg_' + Math.random().toString(36).slice(2, 9),
          age: pick(ageOptions),
          state: pick(stateOptions),
          label: 'Shopper',
          gender: Math.random() < 0.5 ? 'M' : 'F',
          isPlayer: false,
        };
        const mesh = buildCharacter(profile);
        
        const zPos = QUEUE_FRONT_Z + i * QUEUE_SPACING;
        mesh.position.set(0.4 + offsetX, 0, zPos);
        mesh.rotation.y = -Math.PI / 2 + (Math.random() * 0.4 - 0.2);
        
        mesh.traverse((c) => { 
          if (c.isMesh) {
            c.castShadow = false;
            if (c.material) {
              c.material = c.material.clone();
              if (c.material.color) c.material.color.multiplyScalar(0.7);
            }
          }
        });
        
        this.scene.add(mesh);
        this.backgroundNPCs.push({
          mesh,
          bobPhase: Math.random() * Math.PI * 2,
          isCashier: false
        });
      }
    });
  }

  // -----------------------------------------------------------------------
  // Queue → world position mapping. Index 0 = at cashier, increasing = back.
  // -----------------------------------------------------------------------
  queuePosition(idx) {
    if (idx === 0) {
      // at cashier — stand directly in front of counter
      return new THREE.Vector3(CASHIER_X + 1.6, 0, -0.4);
    }
    const z = QUEUE_FRONT_Z + (idx - 1) * QUEUE_SPACING;
    return new THREE.Vector3(0.4, 0, z);
  }

  // -----------------------------------------------------------------------
  // Sync the visible characters with the abstract queue array. Performs
  // smooth tweens on shifts and full add/remove of NPCs that join or leave.
  // -----------------------------------------------------------------------
  // frozenFromIdx: characters at this index and beyond will not have their
  // targetPos updated (used during active events to freeze the player and
  // everyone behind while the queue ahead continues to advance).
  syncQueue(queueArray, frozenFromIdx = Infinity) {
    const seen = new Set();

    queueArray.forEach((npc, idx) => {
      seen.add(npc.id);
      let mesh = this.characterMap.get(npc.id);
      if (!mesh) {
        mesh = buildCharacter(npc);
        mesh.userData.isElderly = (npc.age === 'Elderly');
        this.characterMap.set(npc.id, mesh);
        this.charGroup.add(mesh);
        const queuePos = this.queuePosition(idx);

        // Mid-game arrivals (cutter / friend joiner) walk in slowly from
        // outside the queue line — gives the event a tangible time cost
        // before the player can react. Initial-queue characters just
        // appear at the back-of-line and gently lerp into position.
        const isCutter = npc.state === 'Aggressive' || npc.state === 'Confused';
        const isFriend = npc.state === 'FriendJoiner';

        if (isCutter || isFriend) {
          // Walk in from off-camera right; elderly cutters take longer.
          const startPos = isFriend
            ? new THREE.Vector3(4.5, 0, 7.5)        // store entrance (back-right)
            : new THREE.Vector3(3.5, 0, queuePos.z + 1.4); // sneaking in from the side
          mesh.position.copy(startPos);
          mesh.userData.targetPos = queuePos;
          const walkInS = (npc.age === 'Elderly') ? CONFIG.EVENT_NPC_WALK_IN_S * 1.4
                                                  : CONFIG.EVENT_NPC_WALK_IN_S;
          this.playScript(npc.id, [{ target: queuePos, durationS: walkInS }]);
        } else {
          // Spawn directly at their target position to prevent characters with different speeds 
          // from overtaking each other when the initial queue is generated.
          mesh.position.copy(queuePos);
          mesh.userData.targetPos = queuePos;
        }
      } else {
        if (frozenFromIdx !== Infinity && idx >= frozenFromIdx) {
          // If frozen, keep their existing targetPos so they don't move forward
          // while the person is picking up items
          if (!mesh.userData.targetPos) {
            mesh.userData.targetPos = this.queuePosition(idx);
          }
        } else {
          const baseQueuePos = this.queuePosition(idx);
          mesh.userData.targetPos = baseQueuePos;
        }
      }
      
      mesh.userData.queueIdx = idx;

      if (idx < frozenFromIdx) {
        mesh.userData.targetRotY = idx === 0 ? -Math.PI / 2 : Math.PI;
        mesh.userData.targetHeadRotY = 0;
      }
    });

    // remove anyone who left the queue
    for (const [id, mesh] of this.characterMap.entries()) {
      if (!seen.has(id) && !mesh.userData.exiting) {
        mesh.userData.exiting = true;
        let exitSteps;
        if (mesh.userData.customExitTarget) {
          exitSteps = [{
            target: mesh.userData.customExitTarget,
            durationS: mesh.userData.customExitDurationS || 1.5,
          }];
        } else {
          // Default "successful checkout" exit: step forward past the counter
          // front edge first, THEN walk forward beyond all queues, THEN walk left.
          // This avoids passing through the background queues next door.
          exitSteps = [
            { target: new THREE.Vector3(CASHIER_X + 1.6, 0, 1.6), durationS: 0.7 },
            { target: new THREE.Vector3(CASHIER_X + 1.6, 0, 3.5), durationS: 0.8 },
            { target: new THREE.Vector3(CASHIER_X - 6.0, 0, 3.5), durationS: 1.6 },
          ];
        }
        this.playScript(id, exitSteps, () => {
          // Fade out instead of vanishing instantly. characterMap entry is
          // dropped immediately so syncQueue won't try to control them again,
          // but the mesh remains in the scene for the duration of the fade.
          this.characterMap.delete(id);
          this._fadeOutAndRemove(mesh, 800);
        });
      }
    }
  }

  /**
   * Configure a character's exit animation BEFORE they're removed from the
   * gameState queue, so when syncQueue prunes them they walk out the right way.
   */
  setCustomExit(npcId, target, durationS = 1.5) {
    const mesh = this.characterMap.get(npcId);
    if (!mesh) return;
    mesh.userData.customExitTarget = target;
    mesh.userData.customExitDurationS = durationS;
  }

  /** Spawn a small box that travels along the conveyor belt while a customer is being scanned. */
  spawnScanItem() {
    const colors = [0xef476f, 0xffd166, 0x06d6a0, 0x118ab2, 0xa663cc];
    const c = colors[Math.floor(Math.random() * colors.length)];
    const item = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.18, 0.18),
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 })
    );
    item.castShadow = true;
    // start at the back of the conveyor (right side from camera)
    const startWorld = new THREE.Vector3(CASHIER_X + 1.0, 1.18, -0.0);
    item.position.copy(startWorld);
    item.userData.t = 0;
    this.scene.add(item);
    this.scanItems.push(item);
  }

  setSpectatorFocus(focusId) {
    this.spectatorFocusId = focusId;
  }

  // -----------------------------------------------------------------------
  // Per-frame update: character tweens & scripted moves, gestures, scanner
  // pulse, conveyor scan items, dropped-grocery physics + recovery,
  // urgent-event camera shake.
  // -----------------------------------------------------------------------
  update(dtSec) {
    const t = this.clock.getElapsedTime();
    const nowMs = performance.now();

    for (const [id, mesh] of this.characterMap.entries()) {
      const script = mesh.userData.script;

      // -- POSITION update: scripted vs queue-lerp --
      if (script) {
        script.elapsedS += dtSec;
        const step = script.steps[script.currentStep];
        const tt = Math.min(1, script.elapsedS / step.durationS);
        const ee = easeInOut(tt);
        mesh.position.lerpVectors(script.startPos, step.target, ee);

        if (tt >= 1) {
          script.currentStep++;
          script.elapsedS = 0;
          script.startPos = mesh.position.clone();
          if (step.onArrive) step.onArrive();
          if (script.currentStep >= script.steps.length) {
            delete mesh.userData.script;
            if (script.onComplete) script.onComplete();
          }
        }
      } else {
        const target = mesh.userData.targetPos;
        if (target) {
          const dist = mesh.position.distanceTo(target);
          if (dist > 0.05) {
            mesh.userData.idleTimer = 0;
            const speed = mesh.userData.isElderly ? 1.0 : 3.5;
            mesh.position.lerp(target, Math.min(1, dtSec * speed));
          } else {
            mesh.userData.idleTimer = (mesh.userData.idleTimer || 0) + dtSec;
            mesh.rotation.z = Math.sin(t * 0.4 + mesh.userData.bobPhase) * 0.03;
            if (mesh.userData.idleTimer > 4.5 && Math.random() < 0.005) {
                mesh.userData.idleTimer = 0;
                mesh.userData.idleHeadOffset = (Math.random() - 0.5) * 0.5;
            }
          }
        }
        const bob = Math.sin(t * 1.6 + mesh.userData.bobPhase) * 0.02;
        mesh.position.y = bob;
      }

      // -- BODY ROTATION: rotOverride > script motion direction > targetRotY --
      // (rotOverride is set by events.js during arguments so combatants face
      // each other instead of staring forward in line.)
      let rotTarget = null;
      if (mesh.userData.rotOverride !== undefined) {
        rotTarget = mesh.userData.rotOverride;
      } else if (script) {
        const step = script.steps[script.currentStep];
        if (step) {
          const dir = new THREE.Vector3().subVectors(step.target, script.startPos);
          if (dir.lengthSq() > 0.001) {
            rotTarget = Math.atan2(dir.x, dir.z);
          }
        }
      } else {
        rotTarget = mesh.userData.targetRotY ?? Math.PI / 2;
      }
      if (rotTarget !== null) {
        const diff = shortestAngleDiff(mesh.rotation.y, rotTarget);
        mesh.rotation.y += diff * Math.min(1, dtSec * 4);
      }

      // -- GESTURE overlay (additive body wobble + arm animation) --
      const g = mesh.userData.gesture;
      const ra = mesh.userData.rightArm;
      const la = mesh.userData.leftArm;
      if (g) {
        const ageMs = nowMs - g.startMs;
        if (ageMs >= g.durationMs) {
          this._resetGesturePose(mesh);
          delete mesh.userData.gesture;
        } else {
          const phase = ageMs / g.durationMs;
          if (g.kind === 'shake') {
            // Yelling: body wobble + both arms swinging forward in alternation.
            mesh.rotation.y += Math.sin(phase * Math.PI * 12) * 0.18 * (1 - phase);
            if (ra && la) {
              const s = Math.sin(phase * Math.PI * 6);
              ra.rotation.x = -0.55 - s * 0.45;
              la.rotation.x = -0.55 + s * 0.45;
              ra.rotation.z = ra.userData.baseRotZ - 0.15;
              la.rotation.z = la.userData.baseRotZ + 0.15;
            }
          } else if (g.kind === 'slump') {
            mesh.rotation.x = Math.sin(phase * Math.PI) * 0.22;
            if (ra && la) {
              const s = Math.sin(phase * Math.PI) * 0.30;
              ra.rotation.x = -s;
              la.rotation.x = -s;
            }
          } else if (g.kind === 'point') {
            // Right arm raised forward and slightly outward, jabbing.
            mesh.rotation.z = Math.sin(phase * Math.PI * 4) * 0.18 * (1 - phase);
            if (ra) {
              const raise = Math.sin(phase * Math.PI) * 1.35;
              ra.rotation.x = -raise;
              ra.rotation.z = ra.userData.baseRotZ - Math.sin(phase * Math.PI) * 0.25;
            }
          } else if (g.kind === 'head-shake') {
            mesh.rotation.y += Math.sin(phase * Math.PI * 16) * 0.10 * (1 - phase);
            // Crossed arms / shoulder-shrug
            if (ra) ra.rotation.z = ra.userData.baseRotZ - 0.45;
            if (la) la.rotation.z = la.userData.baseRotZ + 0.45;
          } else if (g.kind === 'dismissive') {
            mesh.rotation.y += Math.sin(phase * Math.PI * 6) * 0.15 * (1 - phase);
            mesh.rotation.x = -Math.sin(phase * Math.PI) * 0.08;
            // Right hand wave-away gesture
            if (ra) {
              ra.rotation.x = -0.45;
              ra.rotation.z = ra.userData.baseRotZ + Math.sin(phase * Math.PI * 4) * 0.4;
            }
          } else if (g.kind === 'wave') {
            if (ra) {
              ra.rotation.x = -2.5; // raise arm high
              ra.rotation.z = ra.userData.baseRotZ + Math.sin(phase * Math.PI * 8) * 0.5;
            }
          } else if (g.kind === 'kneel') {
            // Crouch to pick things up off the floor. The outer group stays
            // upright; the legs compress from the floor up (knee bend) which
            // lowers the hips, and the upper body (torso + head + arms)
            // pitches forward around the hip pivot. Eases in over the first
            // KNEEL_RAMP of the duration, holds, then eases back up.
            const env = phase < KNEEL_RAMP ? phase / KNEEL_RAMP
                      : phase > 1 - KNEEL_RAMP ? (1 - phase) / KNEEL_RAMP
                      : 1;
            const dip = easeInOut(Math.min(1, Math.max(0, env)));
            const ub = mesh.userData.upperBody;
            const legs = mesh.userData.legs;
            let hipDrop = 0;
            if (legs && ub && mesh.userData.canCrouch) {
              // Squash legs about their bottom so the feet stay planted.
              const k = 1 - dip * KNEEL_LEG_SQUASH;
              const bulge = 1 + dip * 0.22; // thighs/knees read wider when bent
              legs.scale.set(bulge, k, bulge);
              legs.position.y = legs.userData.bottomY + legs.userData.halfLen * k;
              hipDrop = (ub.userData.baseY - legs.userData.bottomY) * (1 - k);
            }
            if (ub) {
              ub.position.y = ub.userData.baseY - hipDrop;
              ub.rotation.x = dip * KNEEL_TILT; // +x = lean forward (+Z is facing)
            }
            // Arms: counter-rotate the torso pitch so they hang toward the
            // floor, reach a little further forward, and alternate a small
            // scooping grab (~1.2 Hz, time-based so long kneels don't crawl).
            // A parent cradling a baby keeps both arms on it and only leans down.
            const grab = Math.sin(ageMs * 0.0075) * 0.20;
            const reachX = -(KNEEL_TILT + 0.40);
            const reachArm = (arm, sign) => {
              const bx = arm.userData.baseRotX, bz = arm.userData.baseRotZ;
              const tz = arm.userData.restRotZ * 0.4; // hands a bit closer together
              arm.rotation.x = bx + (reachX + sign * grab - bx) * dip;
              arm.rotation.z = bz + (tz - bz) * dip;
            };
            if (ra && !mesh.userData.babyMesh) reachArm(ra, 1);
            if (la && !mesh.userData.babyMesh) reachArm(la, -1);
          } else if (g.kind === 'argue') {
            // Sustained argument: slow body sway + forward lean + periodic arm jab.
            // Deliberately slow (3–4 cycles) so it reads as intentional anger, not dancing.
            mesh.rotation.x = -0.10 + Math.sin(phase * Math.PI * 3) * 0.06;
            mesh.rotation.z = Math.sin(phase * Math.PI * 2.5 + 0.8) * 0.07;
            if (ra) {
              // Right arm: forward jabs — max(0,sin) so it only jabs forward, never back.
              const jab = Math.max(0, Math.sin(phase * Math.PI * 4)) * 0.55;
              ra.rotation.x = -0.40 - jab;
              ra.rotation.z = ra.userData.baseRotZ - 0.22;
            }
            if (la) {
              // Left arm: slight raise with mild sway.
              la.rotation.x = -0.18 + Math.sin(phase * Math.PI * 2) * 0.12;
              la.rotation.z = la.userData.baseRotZ + 0.18;
            }
          }
        }
      }
    }

    // -- scanner pulse + cashier gaze tracking --
    if (this.scannerMesh) {
      const pulse = 0.6 + Math.abs(Math.sin(t * 4)) * 0.7;
      this.scannerMesh.material.emissiveIntensity = pulse;
    }
    if (this.cashierMesh) {
      const g = this.cashierMesh.userData.gesture;
      if (g) {
        const ageMs = nowMs - g.startMs;
        if (ageMs >= g.durationMs) {
          delete this.cashierMesh.userData.gesture;
        } else {
          const phase = ageMs / g.durationMs;
          this.cashierMesh.rotation.y = Math.sin(phase * Math.PI) * (Math.PI / 3);
        }
      } else {
        // Default gaze: most recent scan item if mid-scan, else customer at idx 0.
        let gazeWorld;
        if (this.scanItems.length > 0) {
          gazeWorld = this.scanItems[this.scanItems.length - 1].position;
        } else {
          const c0 = this.queuePosition(0);
          gazeWorld = new THREE.Vector3(c0.x, 1.2, c0.z);
        }
        const cwp = new THREE.Vector3();
        this.cashierMesh.getWorldPosition(cwp);
        const desired = Math.atan2(gazeWorld.x - cwp.x, gazeWorld.z - cwp.z);
        let cur = this.cashierMesh.rotation.y;
        let diff = desired - cur;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        this.cashierMesh.rotation.y = cur + diff * Math.min(1, dtSec * 3);
      }
    }

    // -- per-NPC head rotation: queue customers turn 90° "left" (face out of
    // the queue toward camera); the cashier customer turns 90° "right" (looks
    // sideways from the cashier). targetHeadRotY is set per-idx in syncQueue. --
    for (const [id, mesh] of this.characterMap.entries()) {
      const head = mesh.userData.headMesh;
      if (!head) continue;
      let target = mesh.userData.targetHeadRotY ?? -Math.PI / 2;
      
      if (mesh.userData.idleHeadOffset) {
         target += mesh.userData.idleHeadOffset;
         mesh.userData.idleHeadOffset *= (1 - dtSec * 1.5);
      }

      if (this.spectatorFocusId && this.spectatorFocusId !== id) {
          const focusMesh = this.characterMap.get(this.spectatorFocusId);
          if (focusMesh && focusMesh.userData.queueIdx !== undefined && mesh.userData.queueIdx !== undefined) {
              const distInQueue = Math.abs(focusMesh.userData.queueIdx - mesh.userData.queueIdx);
              if (distInQueue <= 2) {
                  const dir = new THREE.Vector3().subVectors(focusMesh.position, mesh.position);
                  target = Math.atan2(dir.x, dir.z) - mesh.rotation.y;
                  if (!mesh.userData.spectatorFaceSet) {
                      mesh.userData.spectatorFaceSet = true;
                      if (mesh.userData.emotion !== 'happy') {
                          this.setEmotion(id, Math.random() < 0.5 ? 'neutral' : 'angry');
                      }
                  }
              }
          }
      } else if (mesh.userData.spectatorFaceSet && !this.spectatorFocusId) {
          mesh.userData.spectatorFaceSet = false;
      }
      head.rotation.y += (target - head.rotation.y) * Math.min(1, dtSec * 5);
    }

    // -- background queues shoppers (static, subtle breathing & bobbing) --
    for (const bg of (this.backgroundNPCs || [])) {
      // Subtle breathing / bobbing
      bg.mesh.position.y = Math.sin(t * 1.5 + bg.bobPhase) * 0.015;
      
      if (!bg.isCashier) {
        // Subtle random head movement
        const head = bg.mesh.userData.headMesh;
        if (head) {
          head.rotation.y = Math.sin(t * 0.8 + bg.bobPhase * 2) * 0.15;
        }
      }
    }

    // -- ambient background shoppers (random walk in the back area) --
    for (const a of (this.ambientNPCs || [])) {
      if (nowMs > a.nextRetargetMs) {
        const r = 1.6;
        a.target.set(
          a.home.x + (Math.random() - 0.5) * r,
          0,
          a.home.z + (Math.random() - 0.5) * r * 0.6
        );
        a.target.z = Math.max(-5.7, Math.min(-3.0, a.target.z));
        a.target.x = Math.max(-9, Math.min(9, a.target.x));
        a.nextRetargetMs = nowMs + 4000 + Math.random() * 5000;
      }
      a.mesh.position.lerp(a.target, dtSec * 0.4);
      const dir = new THREE.Vector3().subVectors(a.target, a.mesh.position);
      if (dir.lengthSq() > 0.01) {
        const desired = Math.atan2(dir.x, dir.z);
        let diff = desired - a.mesh.rotation.y;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        a.mesh.rotation.y += diff * Math.min(1, dtSec * 1.6);
      }
      a.mesh.position.y = Math.sin(t * 1.4 + a.bobPhase) * 0.025;
    }

    // -- conveyor scan items --
    for (let i = this.scanItems.length - 1; i >= 0; i--) {
      const it = this.scanItems[i];
      it.userData.t += dtSec;
      if (!this.spectatorFocusId) {
        it.position.x -= dtSec * 0.6;
      }
      it.position.y = 1.18 + Math.sin(t * 5 + i) * 0.005;
      if (it.position.x < CASHIER_X - 0.8) {
        this.scene.remove(it);
        this.scanItems.splice(i, 1);
      }
    }

    // -- dropped grocery items: recovery arc (overrides physics, even for
    // items still in the air), else staggered spawn → fall → low bounce →
    // roll / slide on the floor → settle in a resting pose. --
    for (let i = this.droppedItems.length - 1; i >= 0; i--) {
      const item = this.droppedItems[i];
      if (item.recovering) {
        item.mesh.visible = true;
        const elapsed = nowMs - item.recoverStartMs;
        const tt = Math.min(1, elapsed / item.recoverDurationMs);
        const ee = tt * tt * (3 - 2 * tt); // smoothstep
        const linear = new THREE.Vector3().lerpVectors(item.recoverFrom, item.recoverTo, ee);
        // arc through air (height computed from the actual start point)
        linear.y += Math.sin(tt * Math.PI) * (item.recoverArc ?? 0.7);
        item.mesh.position.copy(linear);
        item.mesh.rotation.x += dtSec * 4;
        item.mesh.rotation.y += dtSec * 3;
        if (tt >= 1) {
          // shrink-fade as it "merges" with the customer
          item.mesh.scale.multiplyScalar(0.85);
          if (item.mesh.scale.x < 0.05) {
            this.scene.remove(item.mesh);
            this.droppedItems.splice(i, 1);
          }
        }
      } else if (!item.settled) {
        if (nowMs < item.spawnAtMs) continue; // still in the bag
        item.mesh.visible = true;
        this._stepDroppedItem(item, Math.min(dtSec, 0.05));
      }
    }

    // -- player plumbob (after gestures so it tracks the posed head) --
    this._updatePlumbob(dtSec, t);

    // -- dynamic camera follow: focus midpoint of (cashier-customer, player),
    // biased toward the cashier so it stays firmly anchored to the front. --
    this._updateCameraFollow(dtSec);

    // -- camera shake (urgent events) --
    let shakeX = 0, shakeY = 0;
    if (this.shake > 0) {
      shakeX = (Math.random() - 0.5) * CONFIG.CAMERA_SHAKE_AMP * this.shake;
      shakeY = (Math.random() - 0.5) * CONFIG.CAMERA_SHAKE_AMP * this.shake;
      this.shake = Math.max(0, this.shake - dtSec * 0.8);
    }
    this.camera.position.set(
      this.cameraBase.x + shakeX,
      this.cameraBase.y + shakeY,
      this.cameraBase.z
    );
    this.camera.lookAt(this.cameraTarget);
  }

  _updateCameraFollow(dtSec) {
    const player = this.characterMap.get('PLAYER');
    if (!player) return;

    // Anchor: cashier-customer slot (world-fixed).
    const cashierFrontX = CASHIER_X + 1.6;   // = -0.8
    const cashierFrontZ = -0.4;
    const px = player.position.x;
    const pz = player.position.z;

    // Queue depth: 0 when player is at cashier, 1 when player is fully back.
    // Drives a smooth blend between "tight cashier framing" and "wide
    // long-queue framing" — when the queue is long, the camera dollies
    // back, rises, and shifts slightly left so the player stays in frame.
    const queueDepth = Math.max(0, pz - cashierFrontZ);
    const t = Math.min(1, queueDepth / 9);

    // Focus: cashier-anchored on short queues, drifts toward the midpoint
    // (between cashier and player) on long queues. A small leftward shift
    // tilts the framing so cashier+player both fit comfortably.
    const cashierBias = 0.6 - t * 0.18;            // 0.60 → 0.42
    const focusX = cashierFrontX * cashierBias + px * (1 - cashierBias) - t * 0.4;
    const focusZ = cashierFrontZ * cashierBias + pz * (1 - cashierBias);

    // Camera offset: pulled back, slightly higher, and a touch left.
    const ox = 5.6 - t * 0.8;                      // 5.6  → 4.8 (shift left)
    const oy = 4.4 + t * 1.3;                      // 4.4  → 5.7 (rises)
    const oz = 5.5 + t * 4.2;                      // 5.5  → 9.7 (dolly back)

    const desiredTarget = new THREE.Vector3(focusX, 1.3, focusZ);
    const desiredBase   = new THREE.Vector3(focusX + ox, oy, focusZ + oz);

    if (this.spectatorFocusId) {
        const specMesh = this.characterMap.get(this.spectatorFocusId);
        if (specMesh) {
            desiredTarget.copy(specMesh.position);
            desiredTarget.y += 1.0;
        }
    }

    this.cameraTarget.lerp(desiredTarget, Math.min(1, dtSec * 0.7));
    this.cameraBase.lerp(desiredBase, Math.min(1, dtSec * 0.7));
  }

  // =======================================================================
  // Visual hooks called from events.js
  // =======================================================================

  /**
   * Drop N grocery items as if a bag slipped out of an NPC's hands: items
   * leave from hand height beside the body, toward the aisle (+X, the side
   * the camera looks at), one after another over ~250-400 ms, fall mostly
   * down and outward, bounce low, then roll / slide to rest scattered
   * ≈0.5-0.9 m from the customer on open floor.
   * Items that haven't left the bag yet are in the scene but invisible
   * until their spawnAtMs.
   */
  dropGroceriesAt(npcId, count = 5) {
    const npcMesh = this.characterMap.get(npcId);
    if (!npcMesh) return [];
    const ud = npcMesh.userData;
    const feet = new THREE.Vector3(npcMesh.position.x, 0, npcMesh.position.z);

    // Spill toward the aisle (world +X). That side of the queue is open floor
    // facing the camera, so the fall and the scattered items are actually
    // seen; dropping "forward" lands them between two customers, hidden
    // behind bodies from the camera's viewpoint. _clearDropYaw still turns
    // away if that spot would be inside the counter.
    const yaw = this._clearDropYaw(feet, Math.PI / 2 + (Math.random() - 0.5) * 0.5);
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const side = new THREE.Vector3(fwd.z, 0, -fwd.x);

    // Hands carrying a bag sit a little above the relaxed hanging height
    // (adult ≈0.88; shorter for youth / stooped elderly).
    const handY = Math.min(0.92, Math.max(0.6, (ud.handY ?? 0.84) + 0.06));
    const frontR = ud.bodyFrontR ?? 0.3; // body (+belly / wheelchair legs) extent ahead
    const nowMs = performance.now();
    const spreadMs = 250 + Math.random() * 150;

    const items = [];
    for (let i = 0; i < count; i++) {
      const mesh = buildGroceryItem();
      const shape = mesh.userData.shape;
      const lateral = (Math.random() - 0.5) * 0.24; // position within the bag
      mesh.position.copy(feet)
        .addScaledVector(fwd, frontR + 0.14 + Math.random() * 0.06)
        .addScaledVector(side, lateral);
      mesh.position.y = handY + Math.random() * 0.05;
      mesh.rotation.set(
        (Math.random() - 0.5) * 0.6,
        Math.random() * Math.PI * 2,
        (Math.random() - 0.5) * 0.6
      );
      mesh.visible = false;
      this.scene.add(mesh);

      // Mostly down + forward, a little sideways fan-out, tiny upward pop.
      const vFwd = 0.20 + Math.random() * 0.30;
      const vSide = lateral * 1.5 + (Math.random() - 0.5) * 0.5;
      const item = {
        mesh,
        physics: {
          vx: fwd.x * vFwd + side.x * vSide,
          vy: -0.15 + Math.random() * 0.35,
          vz: fwd.z * vFwd + side.z * vSide,
          rotX: (Math.random() - 0.5) * 5,
          rotY: (Math.random() - 0.5) * 3,
          rotZ: (Math.random() - 0.5) * 5,
          ...GROCERY_PHYSICS[shape],
          radius: mesh.userData.radius,
          grounded: false,
          blend: 0,
          rollAngle: 0,
          touchQuat: null,
          restQuat: null,
          ownerX: feet.x,
          ownerZ: feet.z,
          ownerR: frontR,
        },
        settled: false,
        recovering: false,
        recoverFrom: null,
        recoverTo: null,
        recoverStartMs: 0,
        recoverDurationMs: 600,
        spawnAtMs: nowMs + (count > 1 ? (i / (count - 1)) * spreadMs : 0),
      };
      if (shape === 'sphere') item.physics.contactY = item.physics.restY = mesh.userData.radius;
      this.droppedItems.push(item);
      items.push(item);
    }
    return items;
  }

  /**
   * Pick a drop direction: the body's facing yaw, unless the landing zone
   * would be inside the cashier counter, in which case try turning left /
   * right. Returns a world yaw (same convention as rotation.y).
   */
  _clearDropYaw(feet, yaw) {
    const offsets = [0, -Math.PI / 4, Math.PI / 4, -Math.PI / 2, Math.PI / 2, Math.PI];
    const probe = new THREE.Vector3();
    for (const off of offsets) {
      const y = yaw + off;
      probe.set(feet.x + Math.sin(y) * 0.8, 0, feet.z + Math.cos(y) * 0.8);
      const m = 0.15;
      const inCounter = probe.x > COUNTER_BOX.minX - m && probe.x < COUNTER_BOX.maxX + m &&
                        probe.z > COUNTER_BOX.minZ - m && probe.z < COUNTER_BOX.maxZ + m;
      if (!inCounter) return y;
    }
    return yaw;
  }

  /** One physics step for a dropped item that has left the bag. */
  _stepDroppedItem(item, dt) {
    const p = item.physics;
    const m = item.mesh;

    if (!p.grounded) {
      // -- airborne: gravity + gentle tumble --
      p.vy -= 9.8 * dt;
      m.position.x += p.vx * dt;
      m.position.y += p.vy * dt;
      m.position.z += p.vz * dt;
      m.rotation.x += p.rotX * dt;
      m.rotation.y += p.rotY * dt;
      m.rotation.z += p.rotZ * dt;
      if (m.position.y <= p.contactY) {
        m.position.y = p.contactY;
        if (p.vy < -0.6) {
          // low bounce: most energy is absorbed, horizontal speed bleeds off
          p.vy = -p.vy * p.restitution;
          p.vx *= p.impactKeep;
          p.vz *= p.impactKeep;
          p.rotX *= 0.5; p.rotY *= 0.5; p.rotZ *= 0.5;
        } else {
          // touchdown: switch to rolling / sliding on the floor
          p.grounded = true;
          p.vy = 0;
          p.touchQuat = m.quaternion.clone();
          p.restQuat = groceryRestQuat(m.userData.shape, p.touchQuat, p.vx, p.vz);
          // roll direction: the lying axis may point either way along up × v
          _tmpAxis.copy(_Y_AXIS).applyQuaternion(p.restQuat);
          p.rollSign = (_tmpAxis.x * p.vz - _tmpAxis.z * p.vx) >= 0 ? 1 : -1;
        }
      }
    } else {
      // -- on the floor: friction decay, ease into the resting pose --
      const speed = Math.hypot(p.vx, p.vz);
      const decay = Math.exp(-p.friction * dt);
      p.vx *= decay;
      p.vz *= decay;
      m.position.x += p.vx * dt;
      m.position.z += p.vz * dt;
      p.blend = Math.min(1, p.blend + dt / 0.22);
      const eb = easeInOut(p.blend);
      m.position.y = p.contactY + (p.restY - p.contactY) * eb;

      if (m.userData.shape === 'sphere') {
        // roll about the horizontal axis perpendicular to travel (up × v)
        if (speed > 1e-4) {
          _tmpAxis.set(p.vz / speed, 0, -p.vx / speed);
          _tmpQuat.setFromAxisAngle(_tmpAxis, speed * dt / p.radius);
          m.quaternion.premultiply(_tmpQuat);
        }
      } else {
        // cans / bottles roll about their own (now horizontal) axis;
        // boxes just slide into their flat pose.
        if (p.rollR > 0) p.rollAngle += p.rollSign * speed * dt / p.rollR;
        _tmpQuat.setFromAxisAngle(_Y_AXIS, p.rollAngle);
        _tmpQuat2.copy(p.restQuat).multiply(_tmpQuat);
        m.quaternion.slerpQuaternions(p.touchQuat, _tmpQuat2, eb);
      }

      if (p.blend >= 1 && speed < 0.03) {
        item.settled = true;
        p.vx = p.vz = 0;
        m.position.y = p.restY;
      }
    }

    this._keepDropClear(item);
  }

  /**
   * Keep a dropped item out of its owner's body (vertical cylinder around
   * where they stood) and out of the cashier counter.
   */
  _keepDropClear(item) {
    const p = item.physics;
    const pos = item.mesh.position;
    const r = p.radius;

    // owner's body
    const dx = pos.x - p.ownerX;
    const dz = pos.z - p.ownerZ;
    const d = Math.hypot(dx, dz);
    const minD = p.ownerR + r;
    if (d < minD && d > 1e-4) {
      const nx = dx / d, nz = dz / d;
      pos.x = p.ownerX + nx * minD;
      pos.z = p.ownerZ + nz * minD;
      const vn = p.vx * nx + p.vz * nz;
      if (vn < 0) { p.vx -= vn * nx; p.vz -= vn * nz; }
    }

    // cashier counter (only matters below the counter top)
    if (pos.y < COUNTER_BOX.topY) {
      const minX = COUNTER_BOX.minX - r, maxX = COUNTER_BOX.maxX + r;
      const minZ = COUNTER_BOX.minZ - r, maxZ = COUNTER_BOX.maxZ + r;
      if (pos.x > minX && pos.x < maxX && pos.z > minZ && pos.z < maxZ) {
        // push out along the axis of least penetration, damped reflection
        const pens = [pos.x - minX, maxX - pos.x, pos.z - minZ, maxZ - pos.z];
        const k = pens.indexOf(Math.min(...pens));
        if (k === 0) { pos.x = minX; p.vx = -Math.abs(p.vx) * 0.2; }
        else if (k === 1) { pos.x = maxX; p.vx = Math.abs(p.vx) * 0.2; }
        else if (k === 2) { pos.z = minZ; p.vz = -Math.abs(p.vz) * 0.2; }
        else { pos.z = maxZ; p.vz = Math.abs(p.vz) * 0.2; }
      }
    }
  }

  /**
   * Animate the given items lifting from wherever they currently are (floor,
   * or still falling) back to an NPC's hands, one at a time with staggered
   * start. Recovery overrides any in-progress physics.
   * @returns total animation duration (ms).
   */
  recoverItemsToNpc(items, toNpcId, perItemDelayMs = 350, perItemDurationMs = 600) {
    const npcMesh = this.characterMap.get(toNpcId);
    if (!npcMesh) return 0;
    let delay = 0;
    for (const item of items) {
      if (item.recovering) continue;                          // already on its way
      if (item.recoverTimer) clearTimeout(item.recoverTimer); // rescheduled (a helper speeds it up)
      const startDelay = delay;
      item.recoverTimer = setTimeout(() => {
        item.recoverTimer = null;
        if (!item.mesh || !item.mesh.parent) return;
        // In front of the receiver's chest, in their facing direction.
        const ry = npcMesh.rotation.y;
        const target = new THREE.Vector3(
          npcMesh.position.x + Math.sin(ry) * 0.25,
          (npcMesh.userData.headY || 1.4) * 0.65,
          npcMesh.position.z + Math.cos(ry) * 0.25
        );
        const from = item.mesh.position.clone();
        item.recovering = true;
        item.mesh.visible = true;     // may not have left the bag yet
        item.recoverFrom = from;
        item.recoverTo = target;
        // Arc peaks a bit above the higher endpoint, measured from the actual
        // start — so floor items get a real lift and mid-air ones don't loop.
        const peakY = Math.max(from.y, target.y) + 0.25;
        item.recoverArc = Math.max(0.1, peakY - (from.y + target.y) / 2);
        item.recoverStartMs = performance.now();
        item.recoverDurationMs = perItemDurationMs;
      }, startDelay);
      delay += perItemDelayMs;
    }
    return delay + perItemDurationMs + 200;
  }

  /**
   * Run a multi-step movement script on a character (overrides queue lerp).
   * @param {string} npcId
   * @param {Array<{target: THREE.Vector3, durationS: number, onArrive?: () => void}>} steps
   * @param {() => void} [onComplete]
   */
  playScript(npcId, steps, onComplete = null) {
    const mesh = this.characterMap.get(npcId);
    if (!mesh) return;
    mesh.userData.script = {
      steps,
      currentStep: 0,
      elapsedS: 0,
      startPos: mesh.position.clone(),
      onComplete,
    };
  }

  clearScript(npcId) {
    const mesh = this.characterMap.get(npcId);
    if (mesh) delete mesh.userData.script;
  }

  /** Trigger a brief gesture animation on a character ('shake', 'slump', 'point', 'head-shake', 'dismissive', 'wave', 'kneel', 'argue'). */
  gestureCharacter(npcId, kind = 'shake', durationMs = 800) {
    const mesh = this.characterMap.get(npcId);
    if (!mesh) return;
    // A gesture interrupted mid-way would otherwise leave its pose behind
    // (e.g. a half crouch) since the next gesture may not touch those parts.
    if (mesh.userData.gesture) this._resetGesturePose(mesh);
    mesh.userData.gesture = { kind, startMs: performance.now(), durationMs };
  }

  /**
   * Restore every transform any gesture animates to its rest value. Leaves
   * the inner group alone, so the elderly stoop is preserved.
   */
  _resetGesturePose(mesh) {
    const ud = mesh.userData;
    mesh.rotation.x = 0;
    mesh.rotation.z = 0;
    mesh.scale.y = 1;
    for (const arm of [ud.rightArm, ud.leftArm]) {
      if (!arm) continue;
      arm.rotation.x = arm.userData.baseRotX;
      arm.rotation.z = arm.userData.baseRotZ;
    }
    const ub = ud.upperBody;
    if (ub) {
      ub.rotation.x = 0;
      ub.position.y = ub.userData.baseY;
    }
    const legs = ud.legs;
    if (legs) {
      legs.scale.set(1, 1, 1);
      legs.position.y = legs.userData.baseY;
    }
  }

  /** Brief cashier turn-and-look gesture (for COMPLAIN_TO_CASHIER). */
  cashierGesture(durationMs = 1500) {
    if (!this.cashierMesh) return;
    this.cashierMesh.userData.gesture = {
      kind: 'turn-look',
      startMs: performance.now(),
      durationMs,
    };
  }

  /**
   * Force a character's body to face a specific yaw angle (in radians, world
   * frame). Takes precedence over both queue-position rotation and script-
   * motion rotation. Used during arguments so combatants face each other
   * instead of staring at the queue. Call clearRotationOverride to release.
   */
  setRotationOverride(npcId, rotY) {
    const mesh = this.characterMap.get(npcId);
    if (mesh) mesh.userData.rotOverride = rotY;
  }
  clearRotationOverride(npcId) {
    const mesh = this.characterMap.get(npcId);
    if (mesh) delete mesh.userData.rotOverride;
  }

  /**
   * Make character A face character B. Returns the angle if both meshes
   * exist (or null otherwise) so callers can verify it took effect.
   */
  faceTowards(npcId, targetNpcId) {
    const a = this.characterMap.get(npcId);
    const b = this.characterMap.get(targetNpcId);
    if (!a || !b) return null;
    const angle = Math.atan2(b.position.x - a.position.x, b.position.z - a.position.z);
    a.userData.rotOverride = angle;
    return angle;
  }

  /** Get a character mesh's current world position (for computing walk targets). */
  getCharacterPos(npcId) {
    const mesh = this.characterMap.get(npcId);
    return mesh ? mesh.position.clone() : null;
  }

  /** World position halfway between two characters (used as "drop site"). */
  getDropSitePos() {
    return new THREE.Vector3(CASHIER_X + 1.0, 0, 0.2);
  }

  /** Repaint a character's face with a new emotion ('neutral'|'happy'|'sad'|'angry'|'surprised'|'shocked'). */
  setEmotion(npcId, emotion) {
    const mesh = this.characterMap.get(npcId);
    if (mesh) this._paintEmotion(mesh, emotion);
  }
  setCashierEmotion(emotion) {
    if (this.cashierMesh) this._paintEmotion(this.cashierMesh, emotion);
  }
  _paintEmotion(mesh, emotion) {
    const fd = mesh.userData.faceData;
    if (!fd) return;
    const profile = mesh.userData.profile || { state: 'Standard' };
    paintFace(fd.ctx, mesh.userData.skinHex, emotion, profile);
    fd.texture.needsUpdate = true;
    mesh.userData.currentEmotion = emotion;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  getLegendData() {
    return [
      { profile: { age: 'Adult', state: 'Standard' }, label: 'Adult Customer', info: 'Standard queue member. Baseline walking speed and average patience.', actions: ['WAIT: Observe events'] },
      { profile: { age: 'Youth', state: 'Standard' }, label: 'Youth', info: 'Smaller body proportions. Custom color palette. Narrative adapts to age when dropping items.', actions: ['WAIT: Observe events', 'HELP (if dropping): Gain 15pts, takes 4s'] },
      { profile: { age: 'Elderly', state: 'Standard' }, label: 'Elderly', info: 'Walks very slowly. Creates natural bottlenecks. 40% slower event walk-in time.', actions: ['WAIT: Stand by', 'HELP (if dropping): Gain 25pts, takes 6s'] },
      { profile: { age: 'Adult', state: 'BusyParent', forceBaby: true }, label: 'Busy Parent (Baby)', info: 'Holds a baby on their chest. Higher base drop chance. Slower recovery.', actions: ['WAIT', 'HELP (if dropping): Gain 20pts'] },
      { profile: { age: 'Adult', state: 'BusyParent', forceToddler: true }, label: 'Busy Parent (Toddler)', info: 'Toddler stands beside them. Same stats as holding a baby variant.', actions: ['WAIT', 'HELP (if dropping): Gain 20pts'] },
      { profile: { age: 'Adult', state: 'Pregnant' }, label: 'Pregnant Woman', info: 'Visible belly. Slightly slower movement.', actions: ['WAIT', 'HELP (if dropping): Gain 20pts'] },
      { profile: { age: 'Adult', state: 'Disabled' }, label: 'Wheelchair User', info: 'Visually distinct with a wheelchair accessory.', actions: ['WAIT', 'HELP (if dropping): Gain 20pts'] },
      { profile: { age: 'Adult', state: 'Aggressive' }, label: 'Aggressive Cutter', info: 'Sneaks in line abruptly. Has glowing red shoulders indicating hostility.', actions: ['ARGUE: Takes 5s, 60% chance they leave, 40% chance you lose 50pts', 'LET IT GO: Instant, lose your spot (-time)'] },
      { profile: { age: 'Adult', state: 'FriendJoiner' }, label: 'Friend Joiner', info: 'Walks in to join a friend already in line. Magenta jacket.', actions: ['ARGUE: Takes 3s, 80% chance they leave', 'LET IT GO: Instant'] }
    ];
  }

  triggerUrgentShake() { this.shake = 1.0; }

  /**
   * Project a 3D point to screen pixels for HUD overlays.
   */
  projectToScreen(vec3) {
    const v = vec3.clone().project(this.camera);
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    return {
      x: (v.x + 1) * 0.5 * w,
      y: (-v.y + 1) * 0.5 * h,
    };
  }

  /** World position above a character's head, for floating text / speech bubbles. */
  getCharacterHeadPos(npcId) {
    const mesh = this.characterMap.get(npcId);
    if (!mesh) return null;
    return new THREE.Vector3(mesh.position.x, mesh.position.y + 1.9, mesh.position.z);
  }

  /** World position above the cashier's head (for cashier speech bubbles). */
  getCashierHeadPos() {
    if (!this.cashierMesh) return null;
    const v = new THREE.Vector3();
    this.cashierMesh.getWorldPosition(v);
    v.y += 1.7;
    return v;
  }

  /**
   * Smoothly fade a character's materials to opacity 0, then remove from
   * the scene. Used when a customer finishes checkout — instead of vanishing
   * abruptly at the end of the exit walk.
   */
  _fadeOutAndRemove(mesh, durationMs = 800) {
    const mats = new Set();
    mesh.traverse((c) => {
      if (c.isMesh && c.material) {
        if (Array.isArray(c.material)) c.material.forEach((m) => mats.add(m));
        else mats.add(c.material);
      }
    });
    mats.forEach((m) => { m.transparent = true; });
    const startMs = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - startMs) / durationMs);
      const o = 1 - t;
      mats.forEach((m) => { m.opacity = o; });
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        this.charGroup.remove(mesh);
        mats.forEach((m) => m.dispose());
      }
    };
    requestAnimationFrame(tick);
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }
}

// ============================================================================
// Procedural character builder. Body proportions, palette and accessories
// vary by age × state so they're visually distinct in queue.
//
// TODO (asset upgrade): replace this with GLTFLoader.loadAsync('characters/...glb')
// when premium GLB models are dropped under public/assets/characters/.
// ============================================================================
const PALETTE = {
  Adult:   { skin: 0xeac6a5, shirt: [0x4a6cf7, 0xf76c4a, 0x06d6a0, 0xffd166], pants: 0x2c3066 },
  Elderly: { skin: 0xddb89a, shirt: [0x9a8eb8, 0x6c7390, 0xb09c8c],            pants: 0x3a3a52 },
  Youth:   { skin: 0xf2d2b6, shirt: [0xff6b6b, 0xfee440, 0x06d6a0, 0x4cc9f0],  pants: 0x4a4a8e },
};
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export function buildCharacter(profile) {
  const group = new THREE.Group();
  // Inner group: holds all body parts. Used for elderly stoop + scale,
  // leaving the outer group's transform clean for queue lerp / scripts / gestures.
  const inner = new THREE.Group();
  group.add(inner);

  const palette = PALETTE[profile.age] || PALETTE.Adult;
  const gender = profile.gender || (Math.random() < 0.5 ? 'M' : 'F');
  const isElderly = profile.age === 'Elderly';
  const isPregnant = profile.state === 'Pregnant';

  const skinColor = palette.skin;
  const skinHex = '#' + skinColor.toString(16).padStart(6, '0');
  const shirtColor = profile.state === 'Cashier' ? 0x29d4c4 : pick(palette.shirt);
  const pantsColor = palette.pants;

  // Body proportions — elderly slightly smaller as a baseline; the inner group
  // additionally scales them by 0.88 and tilts them forward into a stoop.
  let bodyR = 0.28, bodyH = 0.65, headR = 0.21, legH = 0.45;
  if (profile.age === 'Youth')   { bodyR = 0.18; bodyH = 0.40; headR = 0.22; legH = 0.30; }
  if (isElderly)                 { bodyR = 0.27; bodyH = 0.55; headR = 0.20; legH = 0.40; }

  // Legs
  const legs = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.16, legH, 4, 8),
    new THREE.MeshStandardMaterial({ color: pantsColor, roughness: 0.85 })
  );
  legs.position.y = legH / 2 + 0.05;
  legs.castShadow = true;
  inner.add(legs);

  // Upper body: torso, head, arms (and belly / held baby) hang off a hip
  // pivot so the 'kneel' gesture can bend forward at the waist while the
  // legs stay planted. Children are positioned relative to hipY; the
  // *AbsY values below are in inner-group space (feet at y≈0).
  const hipY = profile.state === 'Disabled' ? 0.45 : legH + 0.10;
  const upperBody = new THREE.Group();
  upperBody.position.y = hipY;
  upperBody.userData.baseY = hipY;
  inner.add(upperBody);

  // Body
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(bodyR, bodyH, 6, 12),
    new THREE.MeshStandardMaterial({ color: shirtColor, roughness: 0.7, metalness: 0.0 })
  );
  const bodyAbsY = legH + 0.05 + bodyH / 2 + bodyR * 0.6;
  body.position.y = bodyAbsY - hipY;
  body.castShadow = true;
  
  if (profile.age === 'Youth') {
    const stripeColor = pick(palette.shirt.filter(c => c !== shirtColor)) || 0xffffff;
    const stripe = new THREE.Mesh(
      new THREE.CylinderGeometry(bodyR + 0.005, bodyR + 0.005, bodyH * 0.35, 12),
      new THREE.MeshStandardMaterial({ color: stripeColor, roughness: 0.7 })
    );
    body.add(stripe);
  }
  
  upperBody.add(body);

  // Head with a CanvasTexture face (LEGO-like). Painted once at construction
  // and re-painted on emotion changes via World#setEmotion.
  const faceData = createFaceTexture(skinHex, profile);
  const headMat = new THREE.MeshStandardMaterial({ map: faceData.texture, roughness: 0.55 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(headR, 24, 20), headMat);
  const headAbsY = bodyAbsY + bodyH / 2 + bodyR * 0.6 + headR * 0.95;
  head.position.y = headAbsY - hipY;
  head.castShadow = true;
  upperBody.add(head);

  // Arms — built as Group(shoulder pivot) → Mesh(arm hanging down). Rotating
  // the group rotates the whole arm around the shoulder, letting us animate
  // realistic hand/arm gestures (point, wave, hands-on-hips, etc.) per event.
  const armMat = new THREE.MeshStandardMaterial({ color: shirtColor, roughness: 0.7 });
  const shoulderAbsY = bodyAbsY + bodyH / 2 + 0.15;
  let armL = 0.55, armR = 0.10;
  if (profile.age === 'Youth') { armL = 0.35; armR = 0.07; }

  for (const side of [-1, 1]) {
    const armGroup = new THREE.Group();
    armGroup.position.set(side * (bodyR + 0.10), shoulderAbsY - hipY, 0);
    armGroup.rotation.z = side * 0.08;
    armGroup.userData.baseRotX = 0;
    armGroup.userData.baseRotZ = side * 0.08;
    armGroup.userData.restRotZ = side * 0.08; // natural hang (baseRotZ may be overridden)

    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(armR, armL, 4, 8), armMat);
    arm.position.y = -armL / 2;
    arm.castShadow = true;
    armGroup.add(arm);

    upperBody.add(armGroup);
    if (side === -1) group.userData.leftArm = armGroup;
    else group.userData.rightArm = armGroup;
  }

  // Hair: long for F or pregnant, short for M.
  // Hair is attached to the HEAD mesh (not the inner group) so it rotates
  // together with the head, keeping the "back of the hair" behind the face.
  // Elderly women → off-white long hair; elderly men → balding gray
  // (hair on sides+back, bare patch on top). Others → randomized natural.
  if (gender === 'F' || isPregnant) {
    addLongHair(head, headR, isElderly);
  } else {
    addShortHair(head, headR, isElderly);
  }

  // Pregnant belly
  if (isPregnant) {
    const belly = new THREE.Mesh(
      new THREE.SphereGeometry(bodyR * 0.95, 16, 16),
      new THREE.MeshStandardMaterial({ color: shirtColor, roughness: 0.7 })
    );
    belly.position.set(0, body.position.y - 0.05, bodyR * 0.55);
    belly.castShadow = true;
    upperBody.add(belly);
  }

  // Elderly accessories: walking cane (the hat is gone — replaced by hair,
  // with a bald-pattern variant for elderly men in addShortHair).
  if (isElderly) {
    const cane = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 1.0, 8),
      new THREE.MeshStandardMaterial({ color: 0x6b3f1a, roughness: 0.7 })
    );
    cane.position.set(bodyR + 0.18, 0.55, 0.05);
    cane.castShadow = true;
    inner.add(cane);
  }

  // Wheelchair
  if (profile.state === 'Disabled') {
    // Angle the legs so they start at the bottom of the body and rest on the ground in front
    legs.position.set(0, 0.34, 0.32); // raised significantly higher
    legs.rotation.x = -0.17; // ~10 degrees forward tilt (80 deg from ground)

    const seat = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.10, 0.55),
      new THREE.MeshStandardMaterial({ color: 0x2a2a44, roughness: 0.6 })
    );
    seat.position.y = 0.40;
    seat.castShadow = true;
    inner.add(seat);
    const back = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.7, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x2a2a44, roughness: 0.6 })
    );
    back.position.set(0, 0.75, -0.25);
    back.castShadow = true;
    inner.add(back);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.4 });
    for (const side of [-1, 1]) {
      const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.04, 10, 22), wheelMat);
      wheel.position.set(side * 0.32, 0.22, 0);
      wheel.rotation.y = Math.PI / 2;
      wheel.castShadow = true;
      inner.add(wheel);
    }
  }

  // Busy parent: small kid in tow OR holding a baby
  if (profile.state === 'BusyParent') {
    if (profile.forceBaby || (!profile.forceToddler && Math.random() < 0.5)) {
      // Holding baby
      const baby = new THREE.Group();
      const bBody = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.08, 0.20, 4, 8),
        new THREE.MeshStandardMaterial({ color: 0xff9aa2, roughness: 0.7 })
      );
      bBody.castShadow = true;
      const bFaceData = createFaceTexture(skinHex, { age: 'Youth' });
      const bHeadMat = new THREE.MeshStandardMaterial({ map: bFaceData.texture, roughness: 0.6 });
      const bHead = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 16), bHeadMat);
      bHead.position.set(0, 0.15, 0);
      // The baby is rotated horizontally. Rotate Y by 75 degrees so the face points UP 
      // and slightly FORWARD towards the camera so it is clearly visible.
      bHead.rotation.set(0, Math.PI / 2.4, 0);
      bHead.castShadow = true;
      baby.add(bBody, bHead);
      
      baby.userData.faceData = bFaceData;
      baby.userData.skinHex = skinHex;
      group.userData.babyMesh = baby;
      
      // Raise arms and fold inward to cradle
      if (group.userData.leftArm && group.userData.rightArm) {
          const armRotX = -0.55; // lift arms a bit more forward

          // Lower the shoulders slightly so the whole arm is lower
          group.userData.leftArm.position.y -= 0.05;
          group.userData.rightArm.position.y -= 0.05;
          const armRotZLeft = 0.8; // swing left arm inward
          const armRotZRight = -0.8; // swing right arm inward
          
          group.userData.leftArm.rotation.order = 'ZYX';
          group.userData.rightArm.rotation.order = 'ZYX';
          
          group.userData.leftArm.rotation.set(armRotX, 0, armRotZLeft);
          group.userData.rightArm.rotation.set(armRotX, 0, armRotZRight);
          
          // lock base rots so idle sway doesn't ruin it
          group.userData.leftArm.userData.baseRotX = armRotX;
          group.userData.leftArm.userData.baseRotZ = armRotZLeft;
          group.userData.rightArm.userData.baseRotX = armRotX;
          group.userData.rightArm.userData.baseRotZ = armRotZRight;
      }
      
      // Position cradled on hands
      baby.position.set(0, body.position.y + 0.16, bodyR + 0.03); // baby sitting exactly on hands
      baby.rotation.z = Math.PI / 2.2; // lying horizontally, slight tilt up
      baby.rotation.x = -0.2; // leaning against chest
      upperBody.add(baby);    // (body.position.y is already hip-relative)
    } else {
      // Kid in tow
      const kid = buildCharacter({ age: 'Youth', gender: Math.random() < 0.5 ? 'M' : 'F' });
      kid.position.set(0.40, 0, 0.25); // moved forward
      kid.scale.setScalar(0.7);
      inner.add(kid);
    }
  }

  // Aggressive cutter — red emissive shoulders
  if (profile.state === 'Aggressive') {
    body.material.color.setHex(0xb52a3c);
    body.material.emissive = new THREE.Color(0x550010);
    body.material.emissiveIntensity = 0.25;
  }
  // Friend joiner — magenta jacket
  if (profile.state === 'FriendJoiner') {
    body.material.color.setHex(0xc94aff);
  }

  // Apply elderly stoop + scale (on inner — outer stays clean for game logic)
  if (isElderly) {
    inner.scale.setScalar(0.88);
    inner.rotation.x = 0.16;     // forward stoop
    inner.position.y = -0.04;    // small drop to land legs on the floor
  }

  // (The player marker is no longer built here: World owns a scene-level
  // "plumbob" that tracks the PLAYER's head — see World#_buildPlumbob.)

  // Rest values for the 'kneel' crouch: legs squash about their bottom.
  const legHalfLen = legH / 2 + 0.16; // capsule half-length incl. end caps
  legs.userData.baseY = legs.position.y;
  legs.userData.halfLen = legHalfLen;
  legs.userData.bottomY = legs.position.y - legHalfLen;

  // Bookkeeping for emotion repaint, head-tracking, and HUD anchor positions.
  const innerScale = isElderly ? 0.88 : 1.0;
  group.userData.faceData = faceData;
  group.userData.skinHex = skinHex;
  group.userData.profile = profile;
  group.userData.headMesh = head;
  group.userData.headY = headAbsY * innerScale;
  group.userData.headTopOffset = headR * innerScale;                // head centre → top of head
  group.userData.handY = (shoulderAbsY - armL - armR) * innerScale; // hanging-hand height
  // How far the body extends ahead of the feet (drop spawn clearance).
  group.userData.bodyFrontR = (profile.state === 'Disabled' ? 0.55
                             : isPregnant ? bodyR * 1.5 + 0.03
                             : group.userData.babyMesh ? bodyR + 0.14
                             : bodyR + 0.02) * innerScale;
  group.userData.upperBody = upperBody;
  group.userData.legs = legs;
  group.userData.canCrouch = profile.state !== 'Disabled'; // wheelchair: lean only
  group.userData.bobPhase = Math.random() * Math.PI * 2;
  group.userData.currentEmotion = 'neutral';

  return group;
}

// ----------------------------------------------------------------------------
// Hair builders. All hair is attached as a CHILD of the head mesh so it rotates
// with the head — keeping the "back of the hair" behind the face at all times,
// regardless of how we rotate the head per queue position.
// ----------------------------------------------------------------------------
// Hair-free face wedge centered on the sphere's local +Z direction (where
// the face is painted on the texture). Phi range that EXCLUDES the wedge:
//   phiStart = 0.85π, phiLength = 1.30π   →   wedge is φ∈[0.15π, 0.85π],
//   centered exactly at φ=π/2 (which is +Z = the canvas-face position).
const HAIR_PHI_START  = Math.PI * 0.85;
const HAIR_PHI_LENGTH = Math.PI * 1.30;

function addLongHair(head, headR, isElderly) {
  const hairColor = isElderly
    ? 0xeae8e0   // silver / off-white for elderly women
    : pick([0x3a2417, 0x6b4423, 0xa67953, 0xd4a373, 0x1a1a1a, 0x442a17]);
  const hairMat = new THREE.MeshStandardMaterial({
    color: hairColor, roughness: 0.85, side: THREE.DoubleSide,
  });

  // 1) Top cap — covers the crown only (theta 0..π/3 ≈ upper-third of the
  //    head). Stops well above the eye latitude (~theta=78°), so the cap
  //    never drapes over the eyes. Spans full phi (360°) so the top is solid.
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(headR * 1.06, 24, 14, 0, Math.PI * 2, 0, Math.PI / 3),
    hairMat
  );
  cap.castShadow = true;
  head.add(cap);

  // 2) Back + sides — picks up where the cap ended (theta=π/3), extends down
  //    past the chin, in a phi range that excludes the face wedge.
  const backSides = new THREE.Mesh(
    new THREE.SphereGeometry(headR * 1.05, 24, 18,
      HAIR_PHI_START, HAIR_PHI_LENGTH,
      Math.PI / 3,  Math.PI * 0.75
    ),
    hairMat
  );
  backSides.castShadow = true;
  head.add(backSides);

  // 3) Long flowing tail — vertically-stretched ellipsoid hanging behind
  //    the head, so the back+sides flows naturally into "long hair below".
  const flow = new THREE.Mesh(
    new THREE.SphereGeometry(headR * 0.88, 18, 16),
    hairMat
  );
  flow.scale.set(1.0, 1.7, 0.55);
  flow.position.set(0, -headR * 1.2, -headR * 0.20);
  flow.castShadow = true;
  head.add(flow);
}

function addShortHair(head, headR, isElderly) {
  if (isElderly) {
    // Balding pattern: bald top crown, hair only on the sides+back below
    // the crown. Phi range excludes the face wedge so eyes are exposed.
    const hairMat = new THREE.MeshStandardMaterial({
      color: 0x6e6e6e, roughness: 0.85, side: THREE.DoubleSide,
    });
    const horse = new THREE.Mesh(
      new THREE.SphereGeometry(headR * 1.04, 22, 14,
        HAIR_PHI_START, HAIR_PHI_LENGTH,    // phi: face wedge excluded, centered on +Z
        Math.PI * 0.18, Math.PI * 0.42      // theta: skip top crown, end above ears
      ),
      hairMat
    );
    horse.castShadow = true;
    head.add(horse);
    return;
  }

  // Normal short hair: cap covering only the upper third of the head, so it
  // never reaches the eyes.
  const hairColor = pick([0x2b1a0e, 0x4a2c1a, 0x6b4423, 0x111111, 0x7c5e3e]);
  const hairMat = new THREE.MeshStandardMaterial({ color: hairColor, roughness: 0.85 });
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(headR * 1.04, 22, 14, 0, Math.PI * 2, 0, Math.PI / 3),
    hairMat
  );
  cap.castShadow = true;
  head.add(cap);
}

// ----------------------------------------------------------------------------
// Face texture (LEGO-style). The head sphere uses this canvas as its color map.
// We paint the same face features at three canvas X positions (u=0.25, 0.5,
// 0.75 of the sphere wrap) so a face is reasonably visible to the camera
// regardless of which way the body is rotated in the queue.
// ----------------------------------------------------------------------------
function createFaceTexture(skinHex, profile) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d');
  paintFace(ctx, skinHex, 'neutral', profile);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return { canvas: c, ctx, texture: tex };
}

export function paintFace(ctx, skinHex, emotion, profile) {
  ctx.fillStyle = skinHex;
  ctx.fillRect(0, 0, 512, 256);
  // Single face at canvas (128, 124) — corresponds to the sphere's local +Z
  // surface point. The head mesh is rotated per queue idx so this face ends
  // up on the camera-facing side regardless of body orientation.
  const cx = 128, cy = 124;
  ctx.fillStyle = profile.state === 'Pregnant'
    ? 'rgba(255,170,170,0.22)'
    : 'rgba(255,150,150,0.10)';
  ctx.beginPath(); ctx.arc(cx - 22, cy + 18, 14, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + 22, cy + 18, 14, 0, Math.PI * 2); ctx.fill();
  drawFaceFeatures(ctx, cx, cy, emotion);
}

function drawFaceFeatures(ctx, cx, cy, emotion) {
  ctx.fillStyle = '#1a1a1a';
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const eyeXOff = 18;
  const eyeY = cy - 12;

  // Eyebrows for emotional emphasis
  if (emotion === 'angry') {
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(cx - eyeXOff - 11, eyeY - 14); ctx.lineTo(cx - eyeXOff + 9, eyeY - 6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + eyeXOff + 11, eyeY - 14); ctx.lineTo(cx + eyeXOff - 9, eyeY - 6);
    ctx.stroke();
  } else if (emotion === 'sad') {
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx - eyeXOff - 10, eyeY - 8);  ctx.lineTo(cx - eyeXOff + 10, eyeY - 13);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + eyeXOff + 10, eyeY - 8);  ctx.lineTo(cx + eyeXOff - 10, eyeY - 13);
    ctx.stroke();
  } else if (emotion === 'surprised' || emotion === 'shocked') {
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx - eyeXOff, eyeY - 14, 9, Math.PI, 2 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + eyeXOff, eyeY - 14, 9, Math.PI, 2 * Math.PI);
    ctx.stroke();
  }

  // Eyes
  ctx.fillStyle = '#1a1a1a';
  if (emotion === 'happy') {
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(cx - eyeXOff, eyeY + 2, 8, Math.PI, 2 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx + eyeXOff, eyeY + 2, 8, Math.PI, 2 * Math.PI); ctx.stroke();
  } else if (emotion === 'surprised' || emotion === 'shocked') {
    ctx.beginPath(); ctx.arc(cx - eyeXOff, eyeY, 9, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + eyeXOff, eyeY, 9, 0, Math.PI * 2); ctx.fill();
  } else if (emotion === 'angry') {
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(cx - eyeXOff - 8, eyeY); ctx.lineTo(cx - eyeXOff + 8, eyeY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + eyeXOff - 8, eyeY); ctx.lineTo(cx + eyeXOff + 8, eyeY); ctx.stroke();
  } else if (emotion === 'sad') {
    ctx.beginPath(); ctx.arc(cx - eyeXOff, eyeY, 6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + eyeXOff, eyeY, 6, 0, Math.PI * 2); ctx.fill();
  } else {
    // neutral
    ctx.beginPath(); ctx.arc(cx - eyeXOff, eyeY, 5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + eyeXOff, eyeY, 5, 0, Math.PI * 2); ctx.fill();
  }

  // Mouth
  ctx.strokeStyle = '#5a2828';
  ctx.lineWidth = 3;
  const mouthY = cy + 18;
  if (emotion === 'happy') {
    ctx.beginPath(); ctx.arc(cx, mouthY - 4, 12, 0, Math.PI); ctx.stroke();
  } else if (emotion === 'sad') {
    ctx.beginPath(); ctx.arc(cx, mouthY + 8, 12, Math.PI, 2 * Math.PI); ctx.stroke();
  } else if (emotion === 'angry') {
    ctx.beginPath(); ctx.moveTo(cx - 12, mouthY); ctx.lineTo(cx + 12, mouthY - 1); ctx.stroke();
  } else if (emotion === 'surprised' || emotion === 'shocked') {
    ctx.beginPath(); ctx.arc(cx, mouthY + 4, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#3a1818'; ctx.fill(); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.moveTo(cx - 9, mouthY); ctx.lineTo(cx + 9, mouthY); ctx.stroke();
  }
}

// ============================================================================
// Procedural canvas textures (no external image deps).
// ============================================================================
function makeTileTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');

  // base
  g.fillStyle = '#dcd6c2';
  g.fillRect(0, 0, 256, 256);

  // grid
  g.strokeStyle = 'rgba(0,0,0,0.12)';
  g.lineWidth = 2;
  for (let i = 0; i <= 256; i += 64) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
  }
  // subtle noise speckle
  for (let i = 0; i < 1500; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1, 1);
  }

  return new THREE.CanvasTexture(c);
}

// Smoothstep easing for scripted character moves.
function easeInOut(t) { return t * t * (3 - 2 * t); }

// Shortest signed angle difference (so a body lerping from rotation π to
// rotation -π/2 turns the natural 90°, not the long-way 270°).
function shortestAngleDiff(from, to) {
  let d = to - from;
  while (d > Math.PI)  d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// Procedural grocery item — varied shapes (fruit, can, carton) for visual variety.
// userData.shape selects the drop physics (GROCERY_PHYSICS); userData.radius
// is the item's horizontal clearance radius and, for spheres, the roll radius.
function buildGroceryItem() {
  const r = Math.random();
  let geo, color, shape, radius;
  if (r < 0.30) {
    // fruit (sphere)
    color = pick([0xff6b6b, 0xff9100, 0xfee440, 0x9bc53d, 0x6b3f1a]);
    radius = 0.085 + Math.random() * 0.025;
    geo = new THREE.SphereGeometry(radius, 12, 12);
    shape = 'sphere';
  } else if (r < 0.55) {
    // can (cylinder)
    color = pick([0x118ab2, 0xef476f, 0x06d6a0, 0xd1495b, 0xfdd85d]);
    geo = new THREE.CylinderGeometry(0.07, 0.07, 0.18, 14);
    shape = 'can';
    radius = 0.09;
  } else if (r < 0.80) {
    // carton / box
    color = pick([0xffffff, 0xffeb99, 0xff9aa2, 0xa1c181]);
    geo = new THREE.BoxGeometry(0.16, 0.20, 0.13);
    shape = 'box';
    radius = 0.10;
  } else {
    // bottle (taller cylinder)
    color = pick([0x4ecdc4, 0xc94aff, 0x4a6cf7, 0xff7b00]);
    geo = new THREE.CylinderGeometry(0.05, 0.06, 0.22, 12);
    shape = 'bottle';
    radius = 0.11;
  }
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 })
  );
  mesh.castShadow = true;
  mesh.userData.shape = shape;
  mesh.userData.radius = radius;
  return mesh;
}

// Per-shape drop physics.
//   contactY    — centre height at floor contact while tumbling (≈ half extent)
//   restY       — centre height in the final resting pose (exactly on the floor)
//   restitution — vertical bounce factor (low: groceries don't bounce much)
//   impactKeep  — horizontal speed kept per bounce
//   friction    — exponential decay rate of floor speed (1/s): round things roll further
//   rollR       — roll radius about the item's own axis (0 = slides, no roll)
// Spheres override contactY/restY with their actual radius at drop time.
const GROCERY_PHYSICS = {
  sphere: { contactY: 0.10, restY: 0.10, restitution: 0.26, impactKeep: 0.85, friction: 2.0, rollR: 0 },
  can:    { contactY: 0.09, restY: 0.07, restitution: 0.18, impactKeep: 0.75, friction: 2.2, rollR: 0.07 },
  bottle: { contactY: 0.10, restY: 0.055, restitution: 0.16, impactKeep: 0.65, friction: 3.2, rollR: 0.055 },
  box:    { contactY: 0.10, restY: 0.065, restitution: 0.12, impactKeep: 0.45, friction: 7.0, rollR: 0 },
};

// Scratch objects for per-frame grocery rolling (avoid allocations).
const _Y_AXIS = new THREE.Vector3(0, 1, 0);
const _tmpAxis = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpQuat2 = new THREE.Quaternion();

/**
 * Resting orientation for a grocery item that just touched down, chosen
 * close to its current orientation so the settle blend is a small turn:
 *   box    — largest face down (local Z vertical), keeping its current heading
 *   can / bottle — lying on its side, axis perpendicular to travel (so it rolls)
 *   sphere — unchanged (rolling is applied incrementally)
 */
function groceryRestQuat(shape, touchQuat, vx, vz) {
  if (shape === 'sphere') return touchQuat.clone();
  const qYaw = new THREE.Quaternion();
  const qLay = new THREE.Quaternion();
  const candidates = [];
  if (shape === 'box') {
    // heading from the box's local X projected on the floor
    const xAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(touchQuat);
    const yaw = Math.atan2(-xAxis.z, xAxis.x);
    qYaw.setFromAxisAngle(_Y_AXIS, yaw);
    for (const a of [Math.PI / 2, -Math.PI / 2]) {
      qLay.setFromAxisAngle(new THREE.Vector3(1, 0, 0), a);
      candidates.push(qYaw.clone().multiply(qLay));
    }
  } else {
    // local Y (cylinder axis) → horizontal, then yaw so the axis is
    // perpendicular to travel: axis = up × v̂ (if barely moving, keep heading).
    const speed = Math.hypot(vx, vz);
    let yaw;
    if (speed > 0.02) {
      yaw = Math.atan2(-vx / speed, -vz / speed);
    } else {
      const yAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(touchQuat);
      yaw = Math.atan2(yAxis.z, -yAxis.x);
    }
    qLay.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    for (const y of [yaw, yaw + Math.PI]) {
      qYaw.setFromAxisAngle(_Y_AXIS, y);
      candidates.push(qYaw.clone().multiply(qLay));
    }
  }
  // pick the candidate needing the smallest rotation from the current pose
  let best = candidates[0], bestDot = -1;
  for (const q of candidates) {
    const d = Math.abs(q.dot(touchQuat));
    if (d > bestDot) { bestDot = d; best = q; }
  }
  return best;
}

function makeSignTexture(text) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 192;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  // soft background
  const grad = g.createLinearGradient(0, 0, c.width, 0);
  grad.addColorStop(0, 'rgba(124,92,255,0.0)');
  grad.addColorStop(0.5, 'rgba(124,92,255,0.55)');
  grad.addColorStop(1, 'rgba(41,212,196,0.0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);

  g.font = 'bold 110px Inter, Arial';
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 18;
  g.fillText(text, c.width / 2, c.height / 2);
  return new THREE.CanvasTexture(c);
}


