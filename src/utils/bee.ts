import {
  BeeArgumentError,
  Bytes,
  EthAddress,
  FeedIndex,
  Identifier,
  PrivateKey,
  Reference,
  Signature,
  Span,
  Topic,
} from '@ethersphere/bee-js';
import { Binary } from 'cafe-utility';

export interface Chunk {
  readonly data: Uint8Array;
  span: Span;
  payload: Bytes;
  address: Reference;
}

export interface SingleOwnerChunk extends Chunk {
  identifier: Identifier;
  signature: Signature;
  owner: EthAddress;
}

const ENCODER = new TextEncoder();
const MIN_PAYLOAD_SIZE = 1;
const MAX_PAYLOAD_SIZE = 4096;
const MAX_CHUNK_PAYLOAD_SIZE = 4096;
const SEGMENT_SIZE = 32;

export function makeFeedIdentifier(topic: Topic, index: FeedIndex | number): Identifier {
  index = typeof index === 'number' ? FeedIndex.fromBigInt(BigInt(index)) : index;

  return new Identifier(Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), index.toUint8Array())));
}

export function calculateChunkAddress(chunkContent: Uint8Array): Reference {
  const span = chunkContent.slice(0, Span.LENGTH);
  const payload = chunkContent.slice(Span.LENGTH);
  const rootHash = calculateBmtRootHash(payload);
  const chunkHash = Binary.keccak256(Binary.concatBytes(span, rootHash));

  return new Reference(chunkHash);
}

function calculateBmtRootHash(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_CHUNK_PAYLOAD_SIZE) {
    throw new BeeArgumentError(
      `payload size ${payload.length} exceeds maximum chunk payload size ${MAX_CHUNK_PAYLOAD_SIZE}`,
      payload,
    );
  }
  const input = new Uint8Array(MAX_CHUNK_PAYLOAD_SIZE);
  input.set(payload);

  return Binary.log2Reduce(Binary.partition(input, SEGMENT_SIZE), (a, b) => Binary.keccak256(Binary.concatBytes(a, b)));
}

export function makeContentAddressedChunk(payloadBytes: Uint8Array | string): Chunk {
  if (!(payloadBytes instanceof Uint8Array)) {
    payloadBytes = ENCODER.encode(payloadBytes);
  }

  if (payloadBytes.length < MIN_PAYLOAD_SIZE || payloadBytes.length > MAX_PAYLOAD_SIZE) {
    throw new RangeError(
      `payload size ${payloadBytes.length} exceeds limits [${MIN_PAYLOAD_SIZE}, ${MAX_PAYLOAD_SIZE}]`,
    );
  }

  const span = Span.fromBigInt(BigInt(payloadBytes.length));
  const data = Binary.concatBytes(span.toUint8Array(), payloadBytes);

  return {
    data,
    span,
    payload: Bytes.fromSlice(data, Span.LENGTH),
    address: calculateChunkAddress(data),
  };
}

export function makeSOCAddress(identifier: Identifier, address: EthAddress): Reference {
  return new Reference(Binary.keccak256(Binary.concatBytes(identifier.toUint8Array(), address.toUint8Array())));
}

export function makeSingleOwnerChunk(
  chunk: Chunk,
  identifier: Identifier | Uint8Array | string,
  signer: PrivateKey | Uint8Array | string,
): SingleOwnerChunk {
  identifier = new Identifier(identifier);
  signer = new PrivateKey(signer);
  const address = makeSOCAddress(identifier, signer.publicKey().address());
  const signature = signer.sign(Binary.concatBytes(identifier.toUint8Array(), chunk.address.toUint8Array()));
  const data = Binary.concatBytes(identifier.toUint8Array(), signature.toUint8Array(), chunk.data);

  const span = Span.fromSlice(chunk.data, 0);
  const payload = Bytes.fromSlice(chunk.data, Span.LENGTH);

  return {
    data,
    identifier,
    signature,
    span,
    payload,
    address,
    owner: signer.publicKey().address(),
  };
}
