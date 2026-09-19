export class ConnectionRoutes {
  constructor(routes: string[], probe: (address: string, signal: AbortSignal) => Promise<unknown>, discover?: (signal: AbortSignal) => Promise<string[]>);
  routes: string[]; selected: string | null; lastSelected: string | null; active: boolean;
  update(routes: string[]): void;
  reset(active?: boolean): void;
  select(signal?: AbortSignal): Promise<string>;
}
