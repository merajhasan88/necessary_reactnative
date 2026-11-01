// Tests run where no phone is: the secure random source is Node's.
import { randomBytes } from 'crypto';
import { setSecureRandomSource } from '../../src/requestProof';

setSecureRandomSource(async (count: number) => Uint8Array.from(randomBytes(count)));
