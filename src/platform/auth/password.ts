/**
 * Pure password-reset validation (unit-tested) — shared by the /reset-password
 * server action. Mirrors the signup rule: at least 10 characters (the signup
 * form's minLength), entered twice.
 */

export const PASSWORD_MIN_LENGTH = 10;

export type PasswordResetError = "too_short" | "mismatch";

/** Returns the first validation failure, or null when the pair is acceptable. */
export function validateNewPassword(password: string, confirm: string): PasswordResetError | null {
  if (password.length < PASSWORD_MIN_LENGTH) return "too_short";
  if (password !== confirm) return "mismatch";
  return null;
}
