import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

export class AssetCache {
  private static instance: AssetCache;
  private readonly loader = new GLTFLoader();
  private readonly cache = new Map<string, Promise<GLTF>>();

  private constructor() {}

  static getInstance(): AssetCache {
    if (!AssetCache.instance) {
      AssetCache.instance = new AssetCache();
    }
    return AssetCache.instance;
  }

  async load(url: string): Promise<GLTF> {
    if (!this.cache.has(url)) {
      const promise = new Promise<GLTF>((resolve, reject) => {
        this.loader.load(url, resolve, undefined, reject);
      });
      this.cache.set(url, promise);
    }
    return this.cache.get(url)!;
  }

  async instantiate(url: string): Promise<THREE.Object3D> {
    const gltf = await this.load(url);
    const clonedScene = gltf.scene.clone(true);
    
    // Deep clone materials on meshes so texture assignments do not bleed across instances
    clonedScene.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map((m) => m.clone());
        } else if (mesh.material) {
          mesh.material = mesh.material.clone();
        }
      }
    });

    return clonedScene;
  }
}
