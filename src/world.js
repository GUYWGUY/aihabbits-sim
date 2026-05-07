import * as THREE from 'three';
import { CONFIG } from './config.js';

// ============================================================================
// World: Three.js scene, lighting, environment, characters, camera, render loop.
// ============================================================================

const QUEUE_DIR = new THREE.Vector3(0, 0, 1); // queue extends along +Z away from cashier
const QUEUE_SPACING = 1.25;                   // metres between queue spots
const CASHIER_X = -2.4;                       // counter front edge
const QUEUE_FRONT_Z = -1.0;                   // first queue position (just in front of counter)

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
    this.cameraBase = new THREE.Vector3(5.0, 4.4, 7.5);
    this.cameraTarget = new THREE.Vector3(-0.6, 1.3, 2.0);
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

    this._buildLights();
    this._buildEnvironment();

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
    this._buildCashierStation();

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

  _buildCashierStation() {
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
    this.beltMesh = belt;

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
    this.scannerMesh = scanner;

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
    this.cashierMesh = cashier;

    group.position.set(CASHIER_X, 0, -0.4);
    this.scene.add(group);
    this.cashierGroup = group;
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
  syncQueue(queueArray) {
    const seen = new Set();

    queueArray.forEach((npc, idx) => {
      seen.add(npc.id);
      let mesh = this.characterMap.get(npc.id);
      if (!mesh) {
        mesh = buildCharacter(npc);
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
          // Initial queue spawn — gentle lerp from back-of-line.
          const startPos = this.queuePosition(queueArray.length + 1);
          mesh.position.copy(startPos);
          mesh.userData.targetPos = queuePos;
        }
      } else {
        mesh.userData.targetPos = this.queuePosition(idx);
      }
      // Facing convention:
      //   - In queue (idx > 0): body faces -Z (forward in line). Head NOT
      //     turned — face stays on the body's natural front, aligned with
      //     the pregnant belly / wheelchair / cane. This way the face wedge
      //     in the hair sits exactly where the face is on the body.
      //   - At cashier (idx 0): body faces -X (cashier counter); head turns
      //     90° to the body's right so the face looks sideways out of the
      //     cashier zone toward the camera (player can read emotions).
      // Cashier customer: body faces the cashier counter (-X). Back is to the
      // camera — natural "paying" pose, with pregnant belly / face / hair-free
      // wedge all turned toward the counter.
      // Queue customers: body faces forward in line (-Z). Head aligned.
      mesh.userData.targetRotY = idx === 0 ? -Math.PI / 2 : Math.PI;
      mesh.userData.targetHeadRotY = 0;
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
          // front edge first, THEN walk leftward off-camera. Without the first
          // step the customer would walk straight through the counter mesh.
          exitSteps = [
            { target: new THREE.Vector3(CASHIER_X + 1.6, 0, 1.6), durationS: 0.7 },
            { target: new THREE.Vector3(CASHIER_X - 4.5, 0, 1.6), durationS: 1.6 },
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
          mesh.position.lerp(target, Math.min(1, dtSec * 3.5));
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
          mesh.rotation.x = 0;
          mesh.rotation.z = 0;
          if (ra) { ra.rotation.x = ra.userData.baseRotX; ra.rotation.z = ra.userData.baseRotZ; }
          if (la) { la.rotation.x = la.userData.baseRotX; la.rotation.z = la.userData.baseRotZ; }
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
          } else if (g.kind === 'kneel') {
            // Bend forward, hold, rise. Arms reach forward like picking up.
            if (phase < 0.10)      mesh.rotation.x = (phase / 0.10) * 0.45;
            else if (phase > 0.90) mesh.rotation.x = ((1 - phase) / 0.10) * 0.45;
            else                   mesh.rotation.x = 0.45;
            if (ra && la) {
              ra.rotation.x = -0.65 + Math.sin(phase * Math.PI * 8) * 0.18;
              la.rotation.x = -0.65;
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
    for (const [, mesh] of this.characterMap.entries()) {
      const head = mesh.userData.headMesh;
      if (!head) continue;
      const target = mesh.userData.targetHeadRotY ?? -Math.PI / 2;
      head.rotation.y += (target - head.rotation.y) * Math.min(1, dtSec * 5);
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
      it.position.x -= dtSec * 0.6;
      it.position.y = 1.18 + Math.sin(t * 5 + i) * 0.005;
      if (it.position.x < CASHIER_X - 0.8) {
        this.scene.remove(it);
        this.scanItems.splice(i, 1);
      }
    }

    // -- dropped grocery items: gravity + bounce, or recovery arc --
    for (let i = this.droppedItems.length - 1; i >= 0; i--) {
      const item = this.droppedItems[i];
      if (item.recovering) {
        const elapsed = nowMs - item.recoverStartMs;
        const tt = Math.min(1, elapsed / item.recoverDurationMs);
        const ee = tt * tt * (3 - 2 * tt); // smoothstep
        const linear = new THREE.Vector3().lerpVectors(item.recoverFrom, item.recoverTo, ee);
        // arc through air
        linear.y += Math.sin(tt * Math.PI) * 0.7;
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
        const p = item.physics;
        p.vy -= 9.8 * dtSec;
        item.mesh.position.x += p.vx * dtSec;
        item.mesh.position.y += p.vy * dtSec;
        item.mesh.position.z += p.vz * dtSec;
        item.mesh.rotation.x += p.rotX * dtSec;
        item.mesh.rotation.y += p.rotY * dtSec;
        item.mesh.rotation.z += p.rotZ * dtSec;
        if (item.mesh.position.y <= 0.06) {
          item.mesh.position.y = 0.06;
          p.vy = -p.vy * 0.3;
          p.vx *= 0.5;
          p.vz *= 0.5;
          p.rotX *= 0.4; p.rotY *= 0.4; p.rotZ *= 0.4;
          if (Math.abs(p.vy) < 0.4) {
            item.settled = true;
            p.vy = 0;
            // align flat-ish on floor
            item.mesh.rotation.x = Math.round(item.mesh.rotation.x / Math.PI) * Math.PI;
            item.mesh.rotation.z = 0;
          }
        }
      }
    }

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

    this.cameraTarget.lerp(desiredTarget, Math.min(1, dtSec * 0.7));
    this.cameraBase.lerp(desiredBase, Math.min(1, dtSec * 0.7));
  }

  // =======================================================================
  // Visual hooks called from events.js
  // =======================================================================

  /** Drop N grocery items from an NPC's chest with random scatter velocities. */
  dropGroceriesAt(npcId, count = 5) {
    const headPos = this.getCharacterHeadPos(npcId);
    if (!headPos) return [];
    const origin = headPos.clone();
    origin.y -= 0.5;
    // bias scatter forward (toward camera) so they don't all hide behind the counter
    const items = [];
    for (let i = 0; i < count; i++) {
      const mesh = buildGroceryItem();
      mesh.position.copy(origin);
      this.scene.add(mesh);
      const item = {
        mesh,
        physics: {
          vx: (Math.random() - 0.4) * 1.6,
          vy: 1.0 + Math.random() * 0.7,
          vz: (Math.random() * 0.8) + 0.3,
          rotX: (Math.random() - 0.5) * 7,
          rotY: (Math.random() - 0.5) * 7,
          rotZ: (Math.random() - 0.5) * 7,
        },
        settled: false,
        recovering: false,
        recoverFrom: null,
        recoverTo: null,
        recoverStartMs: 0,
        recoverDurationMs: 600,
      };
      this.droppedItems.push(item);
      items.push(item);
    }
    return items;
  }

  /**
   * Animate the given items lifting from the floor back to an NPC's hands,
   * one at a time with staggered start.
   * @returns total animation duration (ms).
   */
  recoverItemsToNpc(items, toNpcId, perItemDelayMs = 350, perItemDurationMs = 600) {
    const npcMesh = this.characterMap.get(toNpcId);
    if (!npcMesh) return 0;
    let delay = 0;
    for (const item of items) {
      const startDelay = delay;
      setTimeout(() => {
        if (!item.mesh || !item.mesh.parent) return;
        const target = new THREE.Vector3(
          npcMesh.position.x,
          (npcMesh.userData.headY || 1.4) - 0.3,
          npcMesh.position.z + 0.15
        );
        item.recovering = true;
        item.recoverFrom = item.mesh.position.clone();
        item.recoverTo = target;
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

  /** Trigger a brief gesture animation on a character ('shake', 'slump', 'point', 'head-shake', 'dismissive'). */
  gestureCharacter(npcId, kind = 'shake', durationMs = 800) {
    const mesh = this.characterMap.get(npcId);
    if (!mesh) return;
    mesh.userData.gesture = { kind, startMs: performance.now(), durationMs };
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

function buildCharacter(profile) {
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
  if (profile.age === 'Youth')   { bodyR = 0.24; bodyH = 0.50; headR = 0.20; legH = 0.40; }
  if (isElderly)                 { bodyR = 0.27; bodyH = 0.55; headR = 0.20; legH = 0.40; }

  // Legs
  const legs = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.16, legH, 4, 8),
    new THREE.MeshStandardMaterial({ color: pantsColor, roughness: 0.85 })
  );
  legs.position.y = legH / 2 + 0.05;
  legs.castShadow = true;
  inner.add(legs);

  // Body
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(bodyR, bodyH, 6, 12),
    new THREE.MeshStandardMaterial({ color: shirtColor, roughness: 0.7, metalness: 0.0 })
  );
  body.position.y = legH + 0.05 + bodyH / 2 + bodyR * 0.6;
  body.castShadow = true;
  inner.add(body);

  // Head with a CanvasTexture face (LEGO-like). Painted once at construction
  // and re-painted on emotion changes via World#setEmotion.
  const faceData = createFaceTexture(skinHex, profile);
  const headMat = new THREE.MeshStandardMaterial({ map: faceData.texture, roughness: 0.55 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(headR, 24, 20), headMat);
  head.position.y = body.position.y + bodyH / 2 + bodyR * 0.6 + headR * 0.95;
  head.castShadow = true;
  inner.add(head);

  // Arms — built as Group(shoulder pivot) → Mesh(arm hanging down). Rotating
  // the group rotates the whole arm around the shoulder, letting us animate
  // realistic hand/arm gestures (point, wave, hands-on-hips, etc.) per event.
  const armMat = new THREE.MeshStandardMaterial({ color: shirtColor, roughness: 0.7 });
  const shoulderY = body.position.y + bodyH / 2 - 0.10;
  for (const side of [-1, 1]) {
    const armGroup = new THREE.Group();
    armGroup.position.set(side * (bodyR + 0.10), shoulderY, 0);
    armGroup.rotation.z = side * 0.08;
    armGroup.userData.baseRotX = 0;
    armGroup.userData.baseRotZ = side * 0.08;

    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.10, 0.55, 4, 8), armMat);
    arm.position.y = -0.38;
    arm.castShadow = true;
    armGroup.add(arm);

    inner.add(armGroup);
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
    inner.add(belly);
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

  // Busy parent: small kid in tow
  if (profile.state === 'BusyParent') {
    const kid = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.12, 0.18, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0xff9aa2, roughness: 0.7 })
    );
    kid.position.set(0.34, 0.45, 0);
    kid.castShadow = true;
    inner.add(kid);
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

  // Player highlight ring + glow column (added to OUTER group so it stays flat
  // on the floor, unaffected by inner's stoop tilt).
  if (profile.isPlayer) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.55, 48),
      new THREE.MeshBasicMaterial({
        color: 0x29d4c4, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    group.add(ring);
    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.55, 0.05, 32),
      new THREE.MeshBasicMaterial({ color: 0x29d4c4, transparent: true, opacity: 0.18 })
    );
    glow.position.y = 0.025;
    group.add(glow);
  }

  // Bookkeeping for emotion repaint, head-tracking, and HUD anchor positions.
  group.userData.faceData = faceData;
  group.userData.skinHex = skinHex;
  group.userData.profile = profile;
  group.userData.headMesh = head;
  group.userData.headY = head.position.y * (isElderly ? 0.88 : 1.0);
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

function paintFace(ctx, skinHex, emotion, profile) {
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
function buildGroceryItem() {
  const r = Math.random();
  let geo, color;
  if (r < 0.30) {
    // fruit (sphere)
    color = pick([0xff6b6b, 0xff9100, 0xfee440, 0x9bc53d, 0x6b3f1a]);
    geo = new THREE.SphereGeometry(0.085 + Math.random() * 0.025, 12, 12);
  } else if (r < 0.55) {
    // can (cylinder)
    color = pick([0x118ab2, 0xef476f, 0x06d6a0, 0xd1495b, 0xfdd85d]);
    geo = new THREE.CylinderGeometry(0.07, 0.07, 0.18, 14);
  } else if (r < 0.80) {
    // carton / box
    color = pick([0xffffff, 0xffeb99, 0xff9aa2, 0xa1c181]);
    geo = new THREE.BoxGeometry(0.16, 0.20, 0.13);
  } else {
    // bottle (taller cylinder)
    color = pick([0x4ecdc4, 0xc94aff, 0x4a6cf7, 0xff7b00]);
    geo = new THREE.CylinderGeometry(0.05, 0.06, 0.22, 12);
  }
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 })
  );
  mesh.castShadow = true;
  return mesh;
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
