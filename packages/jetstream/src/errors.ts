/** The message of a thrown value, for showing to a person: an Error's message, else the value as text. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
