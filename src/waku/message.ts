// Const for Browser based builds
export const protoSchema = `
syntax = "proto3";

enum MessageType {
  TEXT = 0;
  THREAD = 1;
  REACTION = 2;
}

message MessageData {
  string id = 1;
  optional string targetMessageId = 2;
  MessageType type = 3;
  string message = 4;
  string username = 5;
  string address = 6;
  uint64 timestamp = 7;
  string signature = 8;
  uint32 index = 9;
  string chatTopic = 10;
  string userTopic = 11;
  optional string additionalProps = 12;
}

message MessageStateRef {
  string reference = 1;
  uint64 timestamp = 2;
}

message MessagePayload {
  MessageData message = 1;
  repeated MessageStateRef messageStateRefs = 2;
}
`;
