// 端到端：真实 TCP hub + 两个 peer，验证握手/群聊/广播/离开
import { Hub, TcpHubServer } from '../dist/net/hub.js';
import { Peer } from '../dist/net/peer.js';
import { generateIdentity, deriveRoomKey, roomIdFrom } from '../dist/crypto/identity.js';

const roomName = 'test-room';
const pass = 'hunter2';
const roomId = roomIdFrom(roomName, pass);

const hub = new Hub({ roomId, roomName, passphrase: pass, maxPeers: 64 });
const server = new TcpHubServer(hub);
const port = await server.listen(0, '127.0.0.1');
console.log('hub listening on', port);

const ida = generateIdentity();
const idb = generateIdentity();

const alice = new Peer({ peerId: ida.id, nickname: 'Alice', roomId, passphrase: pass });
const bob = new Peer({ peerId: idb.id, nickname: 'Bob', roomId, passphrase: pass });

const readyA = new Promise((r) => alice.once('ready', r));
const readyB = new Promise((r) => bob.once('ready', r));
const msgOnBob = new Promise((r) => bob.once('message', r));

await alice.connect('tcp', `127.0.0.1:${port}`);
await bob.connect('tcp', `127.0.0.1:${port}`);
await Promise.all([readyA, readyB]);
console.log('both peers ready; hub sees', hub.peerCount, 'peers');
console.log('alice roster:', alice.roomMembers.map((m) => m.nick).join(','));

alice.send({ t: 'chat', id: 'm1', from: alice.id, nick: 'Alice', text: 'hello astral', ts: Date.now() });
const got = await msgOnBob;
console.log('bob received:', JSON.stringify(got));
console.log('E2E chat:', got.text === 'hello astral' ? 'OK' : 'FAIL');

// 错误口令的 peer 应该解不开
const eve = new Peer({ peerId: 'eve', nickname: 'Eve', roomId, passphrase: 'wrong-pass' });
let eveFailed = false;
eve.on('decrypt-failed', () => { eveFailed = true; });
const eveReady = new Promise((r) => eve.once('ready', r));
eve.once('message', () => {});
await eve.connect('tcp', `127.0.0.1:${port}`);
await eveReady;
alice.send({ t: 'chat', id: 'm2', from: alice.id, nick: 'Alice', text: 'secret', ts: Date.now() });
await new Promise((r) => setTimeout(r, 300));
console.log('wrong passphrase rejected:', eveFailed ? 'OK' : 'FAIL');

// 私聊：Alice -> Bob，Eve（错误口令）应完全看不到
const dmOnBob = new Promise((r) => bob.once('dm', r));
bob.on('key-announce', ({ peerId }) => console.log('bob learned key of', peerId.slice(0, 8)));
alice.on('key-announce', ({ peerId }) => console.log('alice learned key of', peerId.slice(0, 8)));
await new Promise((r) => setTimeout(r, 300));
alice.sendDm(idb.id, 'psst: this is private');
const dm = await Promise.race([dmOnBob, new Promise((r) => setTimeout(() => r(null), 2000))]);
console.log('bob got DM:', dm ? JSON.stringify({ to: dm.to, text: dm.text }) : 'TIMEOUT');
console.log('E2E dm:', dm && dm.text === 'psst: this is private' ? 'OK' : 'FAIL');

alice.close();
bob.close();
eve.close();
await new Promise((r) => setTimeout(r, 200));
console.log('after disconnect hub peers:', hub.peerCount);
server.stop();
console.log('stats:', JSON.stringify(hub.statsSnapshot));
console.log('E2E DONE');
