import type { Picked } from './collect';

// Files chosen on the home screen, handed to the Upload page.
let pending: Picked[] | null = null;
export const setPending = (p: Picked[]) => void (pending = p);
export function takePending(): Picked[] | null {
  const p = pending;
  pending = null;
  return p;
}
