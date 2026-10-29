import worker from '../src/index';
export {RelayAuthStore} from '../src/auth-store';
export {WorkspaceBackup} from '../src/workspace-backup';
export default {
 fetch(request:Request,env:any,ctx:ExecutionContext){
  // Only the isolated local test server uses this injected D1 failure.
  env.DB={prepare:()=>{throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit.");}};
  return worker.fetch(request,env,ctx);
 }
};
