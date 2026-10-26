import type { DeskState, UserRole } from '../client/deskState';
import { formatWat } from '../client/format';
import { Pill } from './primitives';

export function TopBar({
  state,
  busy,
  onRole,
  onReset
}: {
  state: DeskState;
  busy: boolean;
  onRole: (role: UserRole) => void;
  onReset: () => void;
}) {
  const { currentUser } = state;
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <span className="brand">Dispatch</span>
        <Pill tone="pending" dot>
          Demo scenario
        </Pill>
        <span className="clock">{formatWat(state.scenarioClockIso)}</span>
        <div className="topbar-end">
          <div className="seg" role="group" aria-label="Role">
            {(['manager', 'operator'] as const).map((role) => (
              <button
                key={role}
                aria-pressed={currentUser.role === role}
                disabled={busy}
                onClick={() => onRole(role)}
              >
                {role === 'manager' ? 'Manager' : 'Operator'}
              </button>
            ))}
          </div>
          <span className="user">{currentUser.name}</span>
          {currentUser.role === 'manager' && (
            <button className="btn btn-quiet" disabled={busy} onClick={onReset}>
              Reset demo
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
