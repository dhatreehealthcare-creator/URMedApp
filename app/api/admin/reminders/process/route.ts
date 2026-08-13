import { getD1 } from "../../../../../db/d1";
import { requireAdminProfile } from "../../../../../lib/admin-access";
import { errorResponse, type LocalProfile } from "../../../../../lib/auth-server";
import { getDueReminderCounts, processDueReminders } from "../../../../../lib/reminder-processing";
import { getRuntimeEnv } from "../../../../../lib/runtime-env";

async function authorize(request: Request): Promise<LocalProfile | null> {
  const configuredSecret = getRuntimeEnv().REMINDER_JOB_SECRET?.trim() ?? "";
  const suppliedSecret = request.headers.get("x-urmed-job-secret") ?? "";
  if (configuredSecret && suppliedSecret === configuredSecret) return null;
  return requireAdminProfile(request);
}

export async function GET(request:Request){
  try{
    await authorize(request);
    const due=await getDueReminderCounts({db:getD1()});
    return Response.json(due,{headers:{"Cache-Control":"private, no-store"}});
  }catch(error){return errorResponse(error);}
}

export async function POST(request:Request){
  try{
    const actor=await authorize(request);
    const result=await processDueReminders({db:getD1(),actorProfileId:actor?.id??null,requestId:request.headers.get("cf-ray")??""});
    return Response.json(result,{headers:{"Cache-Control":"private, no-store"}});
  }catch(error){return errorResponse(error);}
}
