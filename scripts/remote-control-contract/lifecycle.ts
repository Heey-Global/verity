// Executable RC-A state contract. Real transports must enforce these transitions durably.
export type Event =
  'accept' | 'appAttach' | 'installationAttach' | 'cancel' | 'expire' | 'controlReplace';
export type State = {
  phase: 'pending' | 'accepted' | 'active' | 'terminal';
  appAttached: boolean;
  installationAttached: boolean;
  ticketPairs: number;
};

export const initialState: State = {
  phase: 'pending',
  appAttached: false,
  installationAttached: false,
  ticketPairs: 0,
};

export function step(state: State, event: Event): State {
  if (state.phase === 'terminal') return state;
  if (event === 'cancel' || event === 'expire' || event === 'controlReplace') {
    return { ...state, phase: 'terminal', appAttached: false, installationAttached: false };
  }
  if (event === 'accept') {
    return state.phase === 'pending' ? { ...state, phase: 'accepted', ticketPairs: 1 } : state;
  }
  if (state.phase !== 'accepted') return state;
  if (event === 'appAttach') {
    if (state.appAttached) return state;
    return {
      ...state,
      appAttached: true,
      phase: state.installationAttached ? 'active' : 'accepted',
    };
  }
  if (state.installationAttached) return state;
  return { ...state, installationAttached: true, phase: state.appAttached ? 'active' : 'accepted' };
}
