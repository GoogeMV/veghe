import { customAlphabet } from "nanoid";

// Base58: no 0/O or l/I lookalikes.
const base58 = customAlphabet("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz", 10);

export function newMonitorId(): string {
  return base58();
}
