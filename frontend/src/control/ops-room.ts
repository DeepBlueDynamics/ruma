/** Live Hyperia content source: a single pane or a whole tab. */
export type SourceRef =
  | { kind: 'pane'; paneId: string }
  | { kind: 'tab'; tabId: string };

export type SourceConnection =
  | {
      kind: 'desk-monitor';
      deskId: string;
      monitorId: string;
      powered: boolean;
    }
  | {
      kind: 'room-display-section';
      displayId: string;
      sectionId: string;
    };

export type SourceConnectTarget = {
  kind: 'desk-monitor';
  deskId: string;
  monitorId: string;
};

export type OpsRoomSnapshot = {
  schema: 'ops-room/browser-state@1';
  sceneReady: boolean;
  tabs: Array<{ tabId: string; name: string; paneIds: string[] }>;
  panes: Array<{ paneId: string; name: string; shell?: string }>;
  connections: Array<{ source: SourceRef; targets: SourceConnection[] }>;
};

export type OpsRoomCommand =
  | {
      kind: 'source.read';
      source: SourceRef;
    }
  | {
      kind: 'source.connect';
      source: SourceRef;
      target: SourceConnectTarget;
    };

export type OpsRoomCommandResult =
  | {
      ok: true;
      command: OpsRoomCommand['kind'];
      snapshot: OpsRoomSnapshot;
    }
  | {
      ok: false;
      command: OpsRoomCommand['kind'];
      code: 'source_not_found' | 'target_not_ready' | 'invalid_target';
      message: string;
    };

export type OpsRoomFacade = {
  ready: Promise<void>;
  snapshot(): OpsRoomSnapshot;
  dispatch(command: OpsRoomCommand): Promise<OpsRoomCommandResult>;
};

declare global {
  interface Window {
    opsRoom: OpsRoomFacade;
  }
}
