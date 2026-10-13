import { describe, expect, it } from 'vitest';
import { parseLocalDeadline } from '../src/datetime';

describe('English local deadline input',()=>{
  it('keeps an optional empty deadline and preserves the local timezone',()=>{
    expect(parseLocalDeadline('')).toBe(0);
    const seconds=parseLocalDeadline('2030-12-31 12:30');
    expect(seconds).toBe(new Date(2030,11,31,12,30).getTime()/1000);
    expect(parseLocalDeadline('2030-12-31T12:30')).toBe(seconds);
    expect(parseLocalDeadline('2032-02-29 23:59')).toBe(new Date(2032,1,29,23,59).getTime()/1000);
  });
  it.each(['2030-02-29 12:30','2030-02-30 12:30','2030-13-01 12:30','2030-00-01 12:30','2030-12-00 12:30','2030-12-31 24:00','2030-12-31 12:60','12/31/2030 12:30','2030-12-31','2030-12-31 12:30Z','invalid'])('rejects invalid or ambiguous date %s',value=>{
    expect(()=>parseLocalDeadline(value)).toThrow('Enter a valid local date and time as YYYY-MM-DD HH:mm.');
  });
});
