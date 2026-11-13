import type {Env} from './types';
import {one} from './db';
export class WorkCancelled extends Error {constructor(){super('Search stopped or prospect deleted');}}
export async function assertJobActive(env:Env,workflow?:{jobId:string}){
 if(!workflow)return;
 const job=await one<any>(env,'SELECT j.state,l.status lead_status FROM jobs j LEFT JOIN leads l ON l.id=j.lead_id WHERE j.id=?',workflow.jobId);
 if(job?.state==='cancelled'||job?.lead_status==='deleted')throw new WorkCancelled();
}
