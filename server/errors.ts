export class InputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function requireFound<T>(value: T | undefined, message = '找不到这条记录。'): T {
  if (value === undefined) throw new InputError(message, 404);
  return value;
}
