import type { TerminalDefinition, TerminalId } from '../terminal/catalog';

export type TerminalConnection =
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

export type TerminalConnectTarget = {
  kind: 'desk-monitor';
  deskId: string;
  monitorId: string;
};

export type OpsRoomSnapshot = {
  schema: 'ops-room/browser-state@1';
  sceneReady: boolean;
  terminals: TerminalDefinition[];
  terminalConnections: Array<{
    terminalId: TerminalId;
    targets: TerminalConnection[];
  }>;
};

export type OpsRoomCommand =
  | {
      kind: 'terminal.read';
      terminalId: TerminalId;
    }
  | {
      kind: 'terminal.connect';
      terminalId: TerminalId;
      target: TerminalConnectTarget;
    };

export type OpsRoomCommandResult =
  | {
      ok: true;
      command: OpsRoomCommand['kind'];
      snapshot: OpsRoomSnapshot;
      terminal?: TerminalDefinition;
    }
  | {
      ok: false;
      command: OpsRoomCommand['kind'];
      code: 'terminal_not_found' | 'target_not_ready' | 'invalid_target';
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
