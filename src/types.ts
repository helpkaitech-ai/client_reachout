import {offerContext} from './offers';
export interface Env {
 DB: D1Database; ASSETS: Fetcher; AUTH_STORE: DurableObjectNamespace; WORKSPACE_BACKUP?: DurableObjectNamespace;
 PRODUCT_WORKSPACES?: DurableObjectNamespace; GLOBAL_DB?:D1Database; PRODUCT_ID?:string; PRODUCT_NAME?:string; PRODUCT_BRIEF?:string; PRODUCT_APPROVED?:boolean; PRODUCT_REVISION?:number; DISCOVERY_PAUSED_UNTIL?:string;
 APP_URL?: string; ADMIN_PASSWORD?: string; SESSION_SECRET?: string;
 OPENAI_API_KEY?: string; OPENAI_RESEARCH_MODEL?: string; OPENAI_DRAFT_MODEL?: string;
 GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; GOOGLE_REFRESH_TOKEN?: string;
 TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string;
 SENDER_EMAIL?: string; NOTIFY_EMAIL?: string;
 ENABLE_AUTOMATION?: string; ENABLE_SENDING?: string; ENABLE_NOTIFICATIONS?: string;
}
export interface Product {id:string;name:string;website:string;description:string;remarks:string;sender_email:string;revision:number;state:string;analysis:string;approved_revision:number|null;error:string|null;enabled:number;created_at:string;updated_at:string;}
export interface Campaign { query: string; location: string; country: string; timezone: string; enabled: boolean }
export interface Settings {
 locationIds?: string[];
 dailyNewLimit: number; dailyTotalLimit: number; dailyResearchLimit: number;
 openaiBudget: number;
 discoveryResults: number; discoveryIntervalDays: number; discoveryPausedUntil?:string;
 researchAutomation?: boolean;
 sendStartHour: number; sendEndHour: number; sendWeekends: boolean;
 followupDays: number[]; senderName: string; businessAddress: string;
 offerContext: string; portfolio: string; providerPolicyConfirmed: boolean;
 campaigns: Campaign[];
}
export interface Lead {
 id: string; company: string; website: string; domain: string; email: string | null; phone: string;
 country: string; city: string; industry: string; timezone: string; source_url: string; contact_name: string;
 status: string; verification: string; verification_note: string; eligibility: string; eligibility_note: string;
 research: string | null; research_at: string | null; opportunity: string | null; score: number;
 last_inbound_at: string | null; last_sent_at: string | null; next_followup_at: string | null;
 followup_count: number; thread_id: string | null; created_at: string; updated_at: string;
 contact_status?: string; contact_evidence?: string; dossier?: string; solution?: string; research_stage?:string;
}
export interface Draft {
 id: string; lead_id: string; kind: 'initial'|'followup'|'reply'; subject: string; body: string; artifact: string;
 evidence: string; rationale: string; warnings: string; status: string; version: number;
 approved_version: number | null; approved_hash: string | null; approved_at: string | null;
 send_after: string | null; provider_id: string | null; message_id: string | null;
 in_reply_to: string | null; inbound_id: string | null; error: string | null; created_at: string; updated_at: string;
 quality_hold?: string; send_immediately?: number; free_offer?: string;
}
export interface Evidence { observation: string; url: string; kind: 'observed'|'hypothesis'; relevance: string }
export interface Research { report: string; sources: {url:string; title:string}[]; gatheredAt: string }
export interface Job { id:string; kind:string; lead_id:string|null; payload:string; state:string; attempts:number }
export const defaults: Settings = {
 locationIds:['worldwide'],
 dailyNewLimit:12, dailyTotalLimit:12, dailyResearchLimit:20,
 openaiBudget:50, discoveryResults:10, discoveryIntervalDays:3, discoveryPausedUntil:'', researchAutomation:true,
 sendStartHour:9, sendEndHour:17, sendWeekends:false, followupDays:[4,10],
 senderName:'Rushi Shukla', businessAddress:'',
 offerContext,
 portfolio:'', providerPolicyConfirmed:false,
 campaigns:[
  {query:'industrial equipment suppliers',location:'Austin, Texas, USA',country:'US',timezone:'America/Chicago',enabled:true},
  {query:'commercial maintenance companies',location:'Manchester, UK',country:'GB',timezone:'Europe/London',enabled:true},
  {query:'corporate training providers',location:'Singapore',country:'SG',timezone:'Asia/Singapore',enabled:true},
  {query:'event venues',location:'Dublin, Ireland',country:'IE',timezone:'Europe/Dublin',enabled:true},
  {query:'packaging manufacturers',location:'Dubai, UAE',country:'AE',timezone:'Asia/Dubai',enabled:true},
  {query:'equipment rental',location:'Cape Town, South Africa',country:'ZA',timezone:'Africa/Johannesburg',enabled:true}
 ]
};
