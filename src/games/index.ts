/**
 * 游戏模块统一入口。
 * 导入本文件即注册全部游戏（副作用），并导出运行时需要的 API。
 */
import './werewolf.js';
import './monopoly.js';
import './sanguosha.js';

export {
  GameSession,
  registerGame,
  getGame,
  listGames,
  rngFor,
  logAll,
  logTo,
  visibleLog,
  nextAlive,
  alivePlayers,
  playerById,
  tallyVotes,
  topVoted,
} from './engine.js';
export type {
  GameId,
  GameAction,
  GameState,
  GameView,
  GamePlayer,
  GamePhase,
  GameDefinition,
  LogEntry,
} from './engine.js';

export { ROLE_INFO, roleComposition } from './werewolf.js';
export { GENERALS, IDENTITY_INFO, identityComposition, CARD_NAMES } from './sanguosha.js';
export { BOARD_SIZE, START_CASH, buildBoard, currentRent, netWorth } from './monopoly.js';
