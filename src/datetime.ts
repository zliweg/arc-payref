import { PayRefError } from './errors';

/** Parse an explicit local date/time without browser-localized input controls. */
export function parseLocalDeadline(value:string):number {
  if(value==='')return 0;
  const parts=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value);
  const invalid=()=>new PayRefError('INVALID_DATE','create','Enter a valid local date and time as YYYY-MM-DD HH:mm.');
  if(!parts)throw invalid();
  const [,year,month,day,hour,minute]=parts;
  const date=new Date(`${year}-${month}-${day}T${hour}:${minute}:00`);
  const seconds=Math.floor(date.getTime()/1000);
  // Reject rollover dates and times skipped by a local daylight-saving transition.
  if(!Number.isSafeInteger(seconds)||seconds<0||date.getFullYear()!==Number(year)||date.getMonth()+1!==Number(month)||date.getDate()!==Number(day)||date.getHours()!==Number(hour)||date.getMinutes()!==Number(minute))throw invalid();
  return seconds;
}
