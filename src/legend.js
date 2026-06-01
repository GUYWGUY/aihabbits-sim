import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildCharacter, paintFace } from './world.js';

let legendActive = false;
let animationId = null;
let currentMesh = null;

export function initLegendScreen(world, onBack) {
  const container = document.getElementById('legendScreen');
  container.innerHTML = `
    <button id="legend-back" class="btn" style="position:absolute; top:20px; left:20px; z-index:100;">⬅ Back to Menu</button>
    <div class="legend-layout">
      <div class="legend-sidebar glass">
        <h3>Queue Characters</h3>
        <ul id="legend-list" class="legend-list"></ul>
        
        <div class="legend-details" id="legend-details" style="display:none;">
          <h2 id="ld-title"></h2>
          <p id="ld-info"></p>
          <h4>Possible Actions</h4>
          <ul id="ld-actions" class="rules"></ul>
        </div>
      </div>
      <div class="legend-main">
        <canvas id="legend-canvas"></canvas>
      </div>
    </div>
  `;

  document.getElementById('legend-back').addEventListener('click', () => {
    legendActive = false;
    if (animationId) cancelAnimationFrame(animationId);
    container.classList.remove('active');
    if (currentMesh) {
      currentMesh.geometry?.dispose();
      currentMesh.material?.dispose();
    }
    if (onBack) onBack();
  });

  const canvas = document.getElementById('legend-canvas');
  const mainWrapper = document.querySelector('.legend-main');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  
  function resizeCanvas() {
    const rect = mainWrapper.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  }

  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf4f7fa);
  
  // Floor
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xeaeef2, roughness: 1.0 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambientLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(2, 5, 3);
  dirLight.castShadow = true;
  scene.add(dirLight);

  // Setup camera & controls
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 1.2, 4);
  
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.target.set(0, 0.8, 0);

  const legendData = world.getLegendData();
  const listEl = document.getElementById('legend-list');
  const detailsEl = document.getElementById('legend-details');
  const titleEl = document.getElementById('ld-title');
  const infoEl = document.getElementById('ld-info');
  const actionsEl = document.getElementById('ld-actions');

  function selectCharacter(index) {
    const data = legendData[index];
    
    // Update active list item
    Array.from(listEl.children).forEach((li, i) => {
      li.classList.toggle('active', i === index);
    });

    // Update details
    detailsEl.style.display = 'block';
    titleEl.textContent = data.label;
    infoEl.textContent = data.info;
    actionsEl.innerHTML = data.actions.map(act => `<li><span class="ico">⚡</span> ${act}</li>`).join('');

    // Update 3D scene
    if (currentMesh) {
      scene.remove(currentMesh);
    }
    currentMesh = buildCharacter(data.profile);
    // Center it
    currentMesh.position.set(0, 0, 0);
    
    // Smile!
    const fd = currentMesh.userData.faceData;
    if (fd) {
      paintFace(fd.ctx, currentMesh.userData.skinHex, 'happy', data.profile);
      fd.texture.needsUpdate = true;
    }
    const bMesh = currentMesh.userData.babyMesh;
    if (bMesh && bMesh.userData.faceData) {
      paintFace(bMesh.userData.faceData.ctx, bMesh.userData.skinHex, 'happy', { age: 'Youth' });
      bMesh.userData.faceData.texture.needsUpdate = true;
    }
    
    scene.add(currentMesh);
  }

  // Build List
  legendData.forEach((data, i) => {
    const li = document.createElement('li');
    li.textContent = data.label;
    li.addEventListener('click', () => selectCharacter(i));
    listEl.appendChild(li);
  });

  // Handle Resize
  window.addEventListener('resize', () => {
    if (!legendActive) return;
    resizeCanvas();
  });

  // Initial setup
  resizeCanvas();
  selectCharacter(0); // Select first

  // Render loop
  legendActive = true;
  function animate() {
    if (!legendActive) return;
    animationId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
}
