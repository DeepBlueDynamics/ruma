import * as THREE from 'three';

export interface EarthObservatory {
  id: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export const EARTH_OBSERVATORIES: EarthObservatory[] = [
  { id: 'greenwich', name: 'Royal Observatory Greenwich', location: 'Greenwich, UK', latitude: 51.4769, longitude: -0.0005, timezone: 'GMT (UTC+0)' },
  { id: 'paranal', name: 'Paranal Observatory (VLT)', location: 'Atacama, Chile', latitude: -24.6275, longitude: -70.4044, timezone: 'CLT (UTC-3)' },
  { id: 'maunakea', name: 'Mauna Kea Observatory', location: 'Hawaii, USA', latitude: 19.8207, longitude: -155.4681, timezone: 'HST (UTC-10)' },
  { id: 'lapalma', name: 'Roque de los Muchachos', location: 'Canary Islands, Spain', latitude: 28.7636, longitude: -17.8947, timezone: 'WEST (UTC+1)' },
  { id: 'alma', name: 'ALMA Observatory', location: 'Chajnantor, Chile', latitude: -23.0225, longitude: -67.7550, timezone: 'CLT (UTC-3)' },
];

export interface RemoteStarActionPoint {
  id: string;
  name: string;
  bayer: string;
  constellation: string;
  rightAscensionDeg: number;
  declinationDeg: number;
  magnitude: number;
  distanceLy: number;
  spectralClass: string;
  colorHex: number;
}

export const REMOTE_STAR_ACTION_POINTS: RemoteStarActionPoint[] = [
  { id: 'sirius', name: 'Sirius', bayer: 'α Canis Majoris', constellation: 'Canis Major', rightAscensionDeg: 101.287, declinationDeg: -16.716, magnitude: -1.46, distanceLy: 8.6, spectralClass: 'A1V', colorHex: 0xdff2ff },
  { id: 'canopus', name: 'Canopus', bayer: 'α Carinae', constellation: 'Carina', rightAscensionDeg: 95.987, declinationDeg: -52.695, magnitude: -0.74, distanceLy: 310, spectralClass: 'A9II', colorHex: 0xf5f8ff },
  { id: 'alpha-centauri', name: 'Rigil Kentaurus', bayer: 'α Centauri', constellation: 'Centaurus', rightAscensionDeg: 219.902, declinationDeg: -60.833, magnitude: -0.27, distanceLy: 4.37, spectralClass: 'G2V', colorHex: 0xfff7e6 },
  { id: 'arcturus', name: 'Arcturus', bayer: 'α Boötis', constellation: 'Boötes', rightAscensionDeg: 213.915, declinationDeg: 19.182, magnitude: -0.05, distanceLy: 36.7, spectralClass: 'K1.5III', colorHex: 0xffd9b3 },
  { id: 'vega', name: 'Vega', bayer: 'α Lyrae', constellation: 'Lyra', rightAscensionDeg: 279.234, declinationDeg: 38.783, magnitude: 0.03, distanceLy: 25.0, spectralClass: 'A0V', colorHex: 0xebf5ff },
  { id: 'capella', name: 'Capella', bayer: 'α Aurigae', constellation: 'Auriga', rightAscensionDeg: 79.172, declinationDeg: 45.998, magnitude: 0.08, distanceLy: 42.9, spectralClass: 'G3III', colorHex: 0xfff4d6 },
  { id: 'rigel', name: 'Rigel', bayer: 'β Orionis', constellation: 'Orion', rightAscensionDeg: 78.634, declinationDeg: -8.201, magnitude: 0.13, distanceLy: 860, spectralClass: 'B8Ia', colorHex: 0xcfe8ff },
  { id: 'procyon', name: 'Procyon', bayer: 'α Canis Minoris', constellation: 'Canis Minor', rightAscensionDeg: 114.825, declinationDeg: 5.225, magnitude: 0.34, distanceLy: 11.46, spectralClass: 'F5IV-V', colorHex: 0xfffdf2 },
  { id: 'betelgeuse', name: 'Betelgeuse', bayer: 'α Orionis', constellation: 'Orion', rightAscensionDeg: 88.793, declinationDeg: 7.407, magnitude: 0.50, distanceLy: 642.5, spectralClass: 'M1-M2Ia-ab', colorHex: 0xffa477 },
  { id: 'polaris', name: 'Polaris', bayer: 'α Ursae Minoris', constellation: 'Ursa Minor', rightAscensionDeg: 37.954, declinationDeg: 89.264, magnitude: 1.98, distanceLy: 433, spectralClass: 'F7Ib', colorHex: 0xfff9e6 },
  { id: 'altair', name: 'Altair', bayer: 'α Aquilae', constellation: 'Aquila', rightAscensionDeg: 297.695, declinationDeg: 8.868, magnitude: 0.77, distanceLy: 16.73, spectralClass: 'A7V', colorHex: 0xf0f7ff },
  { id: 'aldebaran', name: 'Aldebaran', bayer: 'α Tauri', constellation: 'Taurus', rightAscensionDeg: 68.980, declinationDeg: 16.509, magnitude: 0.85, distanceLy: 65.3, spectralClass: 'K5III', colorHex: 0xffbe94 },
  { id: 'antares', name: 'Antares', bayer: 'α Scorpii', constellation: 'Scorpius', rightAscensionDeg: 247.352, declinationDeg: -26.432, magnitude: 1.06, distanceLy: 550, spectralClass: 'M1.5Iab', colorHex: 0xff8c66 },
];

export function calculateGmtSolarElevation(date = new Date(), latitude = 51.4769, longitude = -0.0005): {
  solarElevationDeg: number;
  solarAzimuthDeg: number;
  isSunDown: boolean;
  twilightState: 'daylight' | 'civil-twilight' | 'nautical-twilight' | 'astronomical-twilight' | 'night';
} {
  const startOfYear = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const dayOfYear = Math.floor((date.getTime() - startOfYear.getTime()) / (24 * 3600 * 1000)) + 1;
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;

  const declination = -23.44 * Math.cos(THREE.MathUtils.degToRad((360 / 365) * (dayOfYear + 10)));
  const b = THREE.MathUtils.degToRad((360 / 365) * (dayOfYear - 81));
  const eot = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);

  const solarTime = utcHours + longitude / 15 + eot / 60;
  const hourAngle = (solarTime - 12) * 15;

  const latRad = THREE.MathUtils.degToRad(latitude);
  const decRad = THREE.MathUtils.degToRad(declination);
  const haRad = THREE.MathUtils.degToRad(hourAngle);

  const sinElevation = Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
  const solarElevationDeg = THREE.MathUtils.radToDeg(Math.asin(Math.max(-1, Math.min(1, sinElevation))));

  const cosAzimuth = (Math.sin(decRad) - Math.sin(latRad) * sinElevation) / (Math.cos(latRad) * Math.cos(Math.asin(sinElevation)));
  let solarAzimuthDeg = THREE.MathUtils.radToDeg(Math.acos(Math.max(-1, Math.min(1, cosAzimuth))));
  if (Math.sin(haRad) > 0) solarAzimuthDeg = 360 - solarAzimuthDeg;

  const isSunDown = solarElevationDeg < 0;

  let twilightState: 'daylight' | 'civil-twilight' | 'nautical-twilight' | 'astronomical-twilight' | 'night' = 'daylight';
  if (solarElevationDeg < -18) twilightState = 'night';
  else if (solarElevationDeg < -12) twilightState = 'astronomical-twilight';
  else if (solarElevationDeg < -6) twilightState = 'nautical-twilight';
  else if (solarElevationDeg < 0) twilightState = 'civil-twilight';

  return {
    solarElevationDeg,
    solarAzimuthDeg,
    isSunDown,
    twilightState,
  };
}

function createEarthTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#06192e';
  ctx.fillRect(0, 0, 512, 256);

  ctx.fillStyle = '#1b4d3e';
  ctx.beginPath(); ctx.ellipse(140, 90, 70, 45, -0.3, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(180, 170, 35, 55, 0.4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(325, 80, 110, 50, 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(290, 145, 55, 60, 0.2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(420, 180, 40, 30, -0.2, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = '#dbeeff';
  ctx.fillRect(0, 0, 512, 12);
  ctx.fillRect(0, 244, 512, 12);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class CelestialSky {
  readonly group = new THREE.Group();
  private starPoints!: THREE.Points;
  private actionStarPoints!: THREE.Points;
  private forceSunState?: 'day' | 'night';
  private activeObservatory: EarthObservatory = EARTH_OBSERVATORIES[0];

  readonly earthMesh: THREE.Mesh;
  readonly sunMesh: THREE.Mesh;
  readonly sunLight: THREE.DirectionalLight;

  constructor(private readonly domeRadius = 500) {
    this.group.name = 'Celestial_Sky_Dome';

    // 1. Build Distant Crisp Background Pinpoint Star Field (R = 500m)
    this.buildBackgroundStarField();

    // 2. Build Distant Action Point Stars (R = 490m) as crisp 2px points
    this.buildActionPointStars();

    // 3. Build Distant Earth Mesh (R = 120m positioned far below at Y = -180m)
    const earthGeo = new THREE.SphereGeometry(120, 32, 32);
    const earthMat = new THREE.MeshStandardMaterial({
      map: createEarthTexture(),
      roughness: 0.65,
      metalness: 0.1,
    });
    this.earthMesh = new THREE.Mesh(earthGeo, earthMat);
    this.earthMesh.position.set(0, -180, -80);
    this.earthMesh.rotation.z = THREE.MathUtils.degToRad(23.44);

    const atmosGeo = new THREE.SphereGeometry(123, 32, 32);
    const atmosMat = new THREE.MeshBasicMaterial({
      color: 0x40dcff,
      transparent: true,
      opacity: 0.18,
      side: THREE.BackSide,
      toneMapped: false,
    });
    const atmosMesh = new THREE.Mesh(atmosGeo, atmosMat);
    this.earthMesh.add(atmosMesh);
    this.group.add(this.earthMesh);

    // 4. Build Distant Sun Mesh (R = 480m)
    const sunGeo = new THREE.SphereGeometry(12, 16, 16);
    const sunMat = new THREE.MeshBasicMaterial({
      color: 0xfffaed,
      toneMapped: false,
    });
    this.sunMesh = new THREE.Mesh(sunGeo, sunMat);

    this.sunLight = new THREE.DirectionalLight(0xfff8eb, 3.2);
    this.sunLight.castShadow = false;
    this.group.add(this.sunLight);
    this.group.add(this.sunMesh);
  }

  setObservatory(id: string): void {
    const found = EARTH_OBSERVATORIES.find(obs => obs.id === id);
    if (found) this.activeObservatory = found;
  }

  getActiveObservatory(): EarthObservatory {
    return this.activeObservatory;
  }

  setForceSunState(state?: 'day' | 'night'): void {
    this.forceSunState = state;
  }

  getForceSunState(): 'day' | 'night' | undefined {
    return this.forceSunState;
  }

  private buildBackgroundStarField(): void {
    const starCount = 2500;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);

    const tempColor = new THREE.Color();

    for (let i = 0; i < starCount; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = this.domeRadius;

      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

      const hue = 0.55 + Math.random() * 0.15;
      const sat = Math.random() * 0.3;
      tempColor.setHSL(hue, sat, 0.75 + Math.random() * 0.25);

      colors[i * 3] = tempColor.r;
      colors[i * 3 + 1] = tempColor.g;
      colors[i * 3 + 2] = tempColor.b;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // sizeAttenuation: false ensures crisp 1.5px pinpoint stars at celestial infinity!
    const material = new THREE.PointsMaterial({
      size: 1.5,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      sizeAttenuation: false,
    });

    this.starPoints = new THREE.Points(geometry, material);
    this.group.add(this.starPoints);
  }

  private buildActionPointStars(): void {
    const count = REMOTE_STAR_ACTION_POINTS.length;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const tempColor = new THREE.Color();

    REMOTE_STAR_ACTION_POINTS.forEach((def, i) => {
      const raRad = THREE.MathUtils.degToRad(def.rightAscensionDeg);
      const decRad = THREE.MathUtils.degToRad(def.declinationDeg);
      const r = this.domeRadius * 0.98;

      positions[i * 3] = r * Math.cos(decRad) * Math.cos(raRad);
      positions[i * 3 + 1] = r * Math.sin(decRad);
      positions[i * 3 + 2] = r * Math.cos(decRad) * Math.sin(raRad);

      tempColor.setHex(def.colorHex);
      colors[i * 3] = tempColor.r;
      colors[i * 3 + 1] = tempColor.g;
      colors[i * 3 + 2] = tempColor.b;
    });

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // Crisp 3px pinpoint star action points with zero mesh overhead
    const material = new THREE.PointsMaterial({
      size: 3.0,
      vertexColors: true,
      transparent: true,
      opacity: 1.0,
      sizeAttenuation: false,
    });

    this.actionStarPoints = new THREE.Points(geometry, material);
    this.group.add(this.actionStarPoints);
  }

  update(now: number, _camera?: THREE.Camera, dateOverride?: Date): {
    solarElevationDeg: number;
    solarAzimuthDeg: number;
    isSunDown: boolean;
    twilightState: string;
  } {
    const nowUtc = dateOverride ?? new Date();
    const obs = this.activeObservatory;
    const solar = calculateGmtSolarElevation(nowUtc, obs.latitude, obs.longitude);

    let effectiveSunDown = solar.isSunDown;
    if (this.forceSunState === 'night') effectiveSunDown = true;
    if (this.forceSunState === 'day') effectiveSunDown = false;

    // Rotate Earth on its axis
    this.earthMesh.rotation.y = (now * 0.00003) % (Math.PI * 2);

    // Position Distant Sun according to GMT Solar Azimuth & Elevation
    const r = this.domeRadius * 0.95;
    const azRad = THREE.MathUtils.degToRad(solar.solarAzimuthDeg);
    const elRad = THREE.MathUtils.degToRad(effectiveSunDown ? -Math.abs(solar.solarElevationDeg) : Math.abs(solar.solarElevationDeg));

    const sunY = r * Math.sin(elRad);
    const projR = r * Math.cos(elRad);
    const sunX = projR * Math.sin(azRad);
    const sunZ = -projR * Math.cos(azRad);

    this.sunMesh.position.set(sunX, sunY, sunZ);
    this.sunLight.position.set(sunX, sunY, sunZ);

    return {
      solarElevationDeg: solar.solarElevationDeg,
      solarAzimuthDeg: solar.solarAzimuthDeg,
      isSunDown: effectiveSunDown,
      twilightState: solar.twilightState,
    };
  }
}
