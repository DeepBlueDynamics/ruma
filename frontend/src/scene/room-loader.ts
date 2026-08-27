import * as THREE from 'three';
import { AssetCache } from '../assets/cache';
import type { RoomDescriptor } from '../descriptors/room-descriptor';

export interface LoadedRoom {
  descriptor: RoomDescriptor;
  shellObject: THREE.Object3D;
  anchors: Map<string, THREE.Object3D>;
  presentationMesh?: THREE.Mesh;
}

export class RoomLoader {
  private readonly assetCache = AssetCache.getInstance();

  async loadRoom(descriptor: RoomDescriptor): Promise<LoadedRoom> {
    const shellObject = await this.assetCache.instantiate(descriptor.shell.asset);
    
    if (descriptor.shell.scale && descriptor.shell.scale !== 1) {
      shellObject.scale.setScalar(descriptor.shell.scale);
    }

    const anchors = new Map<string, THREE.Object3D>();
    let presentationMesh: THREE.Mesh | undefined;

    shellObject.traverse((node) => {
      // Store all named nodes as potential anchors
      if (node.name) {
        anchors.set(node.name, node);
      }

      // Locate presentation screen mesh if configured
      if (descriptor.presentationScreen && node.name === descriptor.presentationScreen) {
        if ((node as THREE.Mesh).isMesh) {
          presentationMesh = node as THREE.Mesh;
        }
      }
    });

    return {
      descriptor,
      shellObject,
      anchors,
      presentationMesh,
    };
  }
}
