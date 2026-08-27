/** Stable logical terminal identity, independent of its current renderer. */
export type TerminalId = string;

export type TerminalAdapter =
  | {
      /** Temporary visual adapter until the real terminal protocol exists. */
      kind: 'placeholder-image';
      asset: string;
    };

export type TerminalDefinition = {
  id: TerminalId;
  label: string;
  terminalType: string;
  lifecycle: 'placeholder' | 'live';
  capabilities: {
    connect: boolean;
    read: boolean;
    input: boolean;
  };
  adapter: TerminalAdapter;
};

export const NAV_SOLUTION_TERMINAL: TerminalDefinition = {
  id: 'terminal:nav.solution',
  label: 'nav.solution',
  terminalType: 'nav-solution',
  lifecycle: 'placeholder',
  capabilities: {
    connect: true,
    read: true,
    input: false,
  },
  adapter: {
    kind: 'placeholder-image',
    asset: '/assets/nav.solution.png',
  },
};

export const NAV_ROUTE_TERMINAL: TerminalDefinition = {
  id: 'terminal:nav.route',
  label: 'nav.route',
  terminalType: 'nav-route',
  lifecycle: 'placeholder',
  capabilities: {
    connect: true,
    read: true,
    input: false,
  },
  adapter: {
    kind: 'placeholder-image',
    asset: '/assets/nav.route.png',
  },
};

export const NAV_WAR_TERMINAL: TerminalDefinition = {
  id: 'terminal:nav.war',
  label: 'nav.war',
  terminalType: 'nav-war',
  lifecycle: 'placeholder',
  capabilities: {
    connect: true,
    read: true,
    input: false,
  },
  adapter: {
    kind: 'placeholder-image',
    asset: '/assets/warnav.png',
  },
};

export const TERMINAL_CATALOG: readonly TerminalDefinition[] = [
  NAV_SOLUTION_TERMINAL,
  NAV_ROUTE_TERMINAL,
  NAV_WAR_TERMINAL,
];

export function terminalById(id: string): TerminalDefinition | undefined {
  return TERMINAL_CATALOG.find(terminal => terminal.id === id);
}
