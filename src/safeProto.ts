function message(label: string | undefined, suffix: string): string {
  return label && label.length > 0 ? `${label} ${suffix}` : suffix;
}

type ErrorFactory = (message: string) => Error;

function makeError(label: string | undefined, suffix: string, createError?: ErrorFactory): Error {
  const errorMessage = message(label, suffix);
  return createError ? createError(errorMessage) : new Error(errorMessage);
}

export function safeGetPrototypeOf(value: object, label?: string, createError?: ErrorFactory): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    throw makeError(label, "prototype must be readable.", createError);
  }
}

export function safeOwnKeys(value: object, label?: string, createError?: ErrorFactory): Array<string | symbol> {
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw makeError(label, "keys must be readable.", createError);
  }
}

export function safeGetOwnPropertyDescriptor(value: object, key: string, label?: string, createError?: ErrorFactory): PropertyDescriptor | undefined;
export function safeGetOwnPropertyDescriptor(value: object, key: string | symbol, label?: string, createError?: ErrorFactory): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw makeError(label, "property descriptors must be readable.", createError);
  }
}
