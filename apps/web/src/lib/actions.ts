/**
 * The app's server actions, for components. Actions that would throw return their failure as a
 * value instead (Next hides a thrown error's message in production); here it is thrown again,
 * message intact, so callers handle failures as before and notices say what really went wrong.
 * Import actions from here, not from "@/app/actions".
 */
import * as server from "@/app/actions";

export * from "@/app/actions";

type Failure = { jinError: string };
const isFailure = (r: unknown): r is Failure => typeof r === "object" && r !== null && "jinError" in r && typeof (r as Failure).jinError === "string";

function rethrow<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  return async (...args: A) => {
    const r = await fn(...args);
    if (isFailure(r)) throw new Error(r.jinError);
    return r;
  };
}

export const collectGithub = rethrow(server.collectGithub);
export const feedAction = rethrow(server.feedAction);
export const feedSet = rethrow(server.feedSet);
export const sweepFeed = rethrow(server.sweepFeed);
export const createChat = rethrow(server.createChat);
export const startTaskSession = rethrow(server.startTaskSession);
export const sendMessage = rethrow(server.sendMessage);
export const modelChoices = rethrow(server.modelChoices);
export const stopSession = rethrow(server.stopSession);
export const streamTicket = rethrow(server.streamTicket);
export const attachTicket = rethrow(server.attachTicket);
export const openTerminal = rethrow(server.openTerminal);
export const startTerminal = rethrow(server.startTerminal);
export const closeTerminal = rethrow(server.closeTerminal);
export const listFiles = rethrow(server.listFiles);
export const writeFile = rethrow(server.writeFile);
export const getDiff = rethrow(server.getDiff);
export const searchMentions = rethrow(server.searchMentions);
export const chatRefs = rethrow(server.chatRefs);
export const listTaskKinds = rethrow(server.listTaskKinds);
export const listRepos = rethrow(server.listRepos);
export const getTaskJob = rethrow(server.getTaskJob);
export const findFiles = rethrow(server.findFiles);
export const searchFiles = rethrow(server.searchFiles);
export const updateTask = rethrow(server.updateTask);
export const revealTask = rethrow(server.revealTask);
export const updateSession = rethrow(server.updateSession);
export const deleteSession = rethrow(server.deleteSession);
export const updateTerminal = rethrow(server.updateTerminal);
export const restartTerminal = rethrow(server.restartTerminal);
export const archivedTerminals = rethrow(server.archivedTerminals);
export const archivedChats = rethrow(server.archivedChats);
export const setNotifications = rethrow(server.setNotifications);
export const testNotification = rethrow(server.testNotification);
export const detachTaskPr = rethrow(server.detachTaskPr);
export const refreshTaskPrs = rethrow(server.refreshTaskPrs);
export const listMachines = rethrow(server.listMachines);
export const getMachine = rethrow(server.getMachine);
export const rerunMachineSetup = rethrow(server.rerunMachineSetup);
export const checkMachineAuth = rethrow(server.checkMachineAuth);
export const startMachineSignIn = rethrow(server.startMachineSignIn);
export const cancelMachineSignIn = rethrow(server.cancelMachineSignIn);
export const detectMachineWorkspaces = rethrow(server.detectMachineWorkspaces);
export const removeMachine = rethrow(server.removeMachine);
export const getSetup = rethrow(server.getSetup);
export const checkSetupAuth = rethrow(server.checkSetupAuth);
export const startSetupSignIn = rethrow(server.startSetupSignIn);
export const cancelSetupSignIn = rethrow(server.cancelSetupSignIn);
export const getLive = rethrow(server.getLive);
export const liveListener = rethrow(server.liveListener);
export const getHooks = rethrow(server.getHooks);
export const getNotificationKinds = rethrow(server.getNotificationKinds);
export const listDocs = rethrow(server.listDocs);
export const listMemory = rethrow(server.listMemory);
export const editMemory = rethrow(server.editMemory);
export const getPreContext = rethrow(server.getPreContext);
export const refreshPreContext = rethrow(server.refreshPreContext);
export const removePreContext = rethrow(server.removePreContext);
export const addPreContext = rethrow(server.addPreContext);
export const archiveDoc = rethrow(server.archiveDoc);
export const askDoc = rethrow(server.askDoc);
export const docVersions = rethrow(server.docVersions);
export const docVersion = rethrow(server.docVersion);
