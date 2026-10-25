/**
 * 房间特性统一入口。
 */
export { FileTransfer, formatBytes, safeName, CHUNK_SIZE_LAN, CHUNK_SIZE_BT, MAX_FILE_SIZE } from './filetransfer.js';
export type { FileOffer, TransferProgress } from './filetransfer.js';
export { PollManager } from './poll.js';
export type { Poll, PollOption } from './poll.js';
