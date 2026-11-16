export const PROJECTS = ['教学', '科研申请', '学生事务', '行政报销', '合作交流', '个人事务'];
export function today(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = k => parts.find(p => p.type === k).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function nextBillDate(day, repeat, anchorDay = Number(day.slice(8))) {
  const months = { monthly: 1, quarterly: 3, yearly: 12 }[repeat];
  if (!months) return '';
  const d = new Date(`${day}T12:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, 12));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(anchorDay, last));
  return target.toISOString().slice(0, 10);
}
export function validDate(value) {
  return value === '' || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value);
}
// Keep labelled deadlines intact; use the earliest known deadline for planning.
export function effectiveDueDate(task) {
  return [task.dueDate, task.internalDueDate, task.externalDueDate].filter(Boolean).sort()[0] || '';
}
export function attention(t, day = today()) {
  t = {...t, dueDate: effectiveDueDate(t)};
  if (t.deletedAt || !['todo', 'waiting'].includes(t.status)) return false;
  return Boolean((t.dueDate && t.dueDate <= addDays(day, 2)) || (t.status === 'waiting' && t.followUpDate && t.followUpDate <= day));
}
export function isToday(t, day = today()) {
  if (t.deletedAt || !['todo', 'waiting'].includes(t.status)) return false;
  if (attention(t, day)) return true;
  return t.status === 'todo' && (!t.planDate || t.planDate <= day);
}
export function score(t, day = today()) {
  t = {...t, dueDate: effectiveDueDate(t)};
  let n = t.priority === 'high' ? 35 : 0;
  if (t.dueDate && t.dueDate < day) n += 160;
  else if (t.dueDate === day) n += 120;
  else if (t.dueDate && t.dueDate <= addDays(day, 2)) n += 70;
  if (t.status === 'waiting' && t.followUpDate && t.followUpDate <= day) n += 65;
  if (t.planDate && t.planDate < day) n += Math.min(20, Math.round((Date.parse(day) - Date.parse(t.planDate)) / 86400000));
  return n;
}
export function sorted(tasks, day = today()) {
  return [...tasks].sort((a, b) => score(b, day) - score(a, day) || (effectiveDueDate(a) || '9999').localeCompare(effectiveDueDate(b) || '9999') || a.createdAt.localeCompare(b.createdAt));
}
export function validateTask(input, previous = null, day = today()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('任务格式不正确');
  const t = { title: '', kind: 'task', bill: null, project: '科研申请', priority: 'normal', status: 'todo', planDate: day, dueDate: '', followUpDate: '', notes: '', link: '', steps: [], ...previous };
  for (const k of ['title', 'kind', 'bill', 'project', 'priority', 'status', 'planDate', 'dueDate', 'followUpDate', 'notes', 'link', 'steps', 'source', 'workType', 'importance', 'estimatedMinutes', 'calendarKey', 'completionEvidence', 'longTerm', 'internalDueDate', 'externalDueDate', 'deadlineEvidence', 'opportunity']) {
    if (Object.hasOwn(input, k)) t[k] = input[k];
  }
  for (const k of ['title', 'project', 'priority', 'status', 'planDate', 'dueDate', 'followUpDate', 'notes', 'link']) if (typeof t[k] !== 'string') throw new Error(`字段 ${k} 必须为文字`);
  t.title = t.title.trim();
  if (!t.title || t.title.length > 300) throw new Error('请填写 1–300 字的任务名称');
  if (!PROJECTS.includes(t.project)) throw new Error('请选择有效的分类');
  if (!['todo', 'waiting', 'review', 'done', 'cancelled'].includes(t.status)) throw new Error('任务状态不正确');
  if (!['normal', 'high'].includes(t.priority)) throw new Error('重要程度不正确');
  for (const k of ['planDate', 'dueDate', 'followUpDate']) if (!validDate(t[k])) throw new Error('请使用有效的日期，例如 2026-11-13');
  t.longTerm ??= false;
  if (typeof t.longTerm !== 'boolean') throw new Error('Long-term must be true or false.');
  for (const k of ['internalDueDate', 'externalDueDate']) {
    if (t[k] === undefined) t[k] = '';
    if (!validDate(t[k])) throw new Error('Use a valid internal or external deadline.');
  }
  if (t.deadlineEvidence != null) {
    if (typeof t.deadlineEvidence !== 'object' || Array.isArray(t.deadlineEvidence)) throw new Error('Invalid deadline evidence.');
    const clean = {};
    for (const key of ['internal', 'external']) {
      const e = t.deadlineEvidence[key]; if (e == null) continue;
      if (typeof e !== 'object' || typeof e.url !== 'string' || !/^https:\/\//i.test(e.url) || e.url.length > 4000 || typeof e.excerpt !== 'string' || !e.excerpt.trim() || e.excerpt.length > 1500) throw new Error('Deadline evidence needs an HTTPS source and excerpt.');
      clean[key] = {url:e.url, excerpt:e.excerpt};
    }
    t.deadlineEvidence = clean;
  }
  if (t.opportunity != null) {
    const o = t.opportunity;
    if (typeof o !== 'object' || !['funding','award','invitation','other'].includes(o.type) || !['consider','possible','skip'].includes(o.recommendation) || !['eligible','unknown','ineligible'].includes(o.eligibilityStatus)) throw new Error('Invalid opportunity assessment.');
    const clean = {type:o.type, recommendation:o.recommendation, eligibilityStatus:o.eligibilityStatus};
    for (const key of ['fit','eligibility','effort']) {
      if (typeof o[key] !== 'string' || !o[key].trim() || o[key].length > 1500) throw new Error('Opportunities need fit, eligibility and effort assessments.');
      clean[key] = o[key].trim();
    }
    t.opportunity = clean;
  }
  if (t.status === 'waiting' && !t.followUpDate) throw new Error('等待回复的事项需要设置跟进日期');
  if (t.link && (!/^https?:\/\//i.test(t.link) || t.link.length > 2000)) throw new Error('相关链接需以 https:// 或 http:// 开头');
  if (t.notes.length > 20000) throw new Error('备注过长');
  if (!Array.isArray(t.steps) || t.steps.length > 40) throw new Error('最多支持 40 个步骤');
  t.steps = t.steps.map((s, i) => {
    if (!s || typeof s.text !== 'string' || !s.text.trim() || s.text.length > 300 || typeof s.done !== 'boolean') throw new Error('步骤格式不正确');
    return { id: typeof s.id === 'string' ? s.id.slice(0, 80) : `step-${i}`, text: s.text.trim(), done: s.done };
  });
  if (new Set(t.steps.map(s => s.id)).size !== t.steps.length) throw new Error('步骤编号不能重复');
  if (t.status === 'done' && t.steps.some(s => !s.done)) throw new Error('请先完成所有步骤，或编辑并移除不再需要的步骤');
  t.workType ||= 'auto'; t.importance ||= 'auto';
  if (!['auto','deep','admin','misc'].includes(t.workType) || !['auto','high','normal'].includes(t.importance)) throw new Error('工作类型或重要程度不正确');
  if (t.estimatedMinutes !== undefined && t.estimatedMinutes !== null && (!Number.isInteger(t.estimatedMinutes) || t.estimatedMinutes < 5 || t.estimatedMinutes > 480)) throw new Error('预计耗时需为 5–480 分钟');
  if (t.calendarKey !== undefined && (typeof t.calendarKey !== 'string' || t.calendarKey.length > 1000)) throw new Error('日历来源标识不正确');
  if (!['task', 'bill'].includes(t.kind)) throw new Error('事项类型不正确');
  if (t.kind === 'bill') {
    if (!t.dueDate) throw new Error('请设置账单到期日');
    if (t.status === 'waiting') throw new Error('账单请使用待支付、已支付或忽略状态');
    if (t.bill !== null && (typeof t.bill !== 'object' || Array.isArray(t.bill))) throw new Error('账单格式不正确');
    const b = { payee: '', amount: '', currency: 'HKD', repeat: 'none', amountMode: 'variable', remindDays: 7, ...previous?.bill };
    for (const key of ['payee', 'amount', 'currency', 'repeat', 'amountMode', 'remindDays']) if (t.bill && Object.hasOwn(t.bill, key)) b[key] = t.bill[key];
    if (typeof b.payee !== 'string' || b.payee.length > 200) throw new Error('收款机构名称过长');
    if (typeof b.amount !== 'string' || (b.amount && !/^\d{1,9}(\.\d{1,2})?$/.test(b.amount))) throw new Error('金额请填写正数，最多两位小数；未知可留空');
    if (!['HKD', 'CNY', 'USD', 'EUR', 'GBP'].includes(b.currency)) throw new Error('账单币种不正确');
    if (!['none', 'monthly', 'quarterly', 'yearly'].includes(b.repeat)) throw new Error('账单重复周期不正确');
    if (!['variable', 'fixed'].includes(b.amountMode)) throw new Error('账单金额模式不正确');
    if (!Number.isInteger(b.remindDays) || b.remindDays < 0 || b.remindDays > 30) throw new Error('账单提醒需在到期前 0–30 天');
    b.anchorDay = previous?.dueDate === t.dueDate && previous?.bill?.anchorDay ? previous.bill.anchorDay : Number(t.dueDate.slice(8));
    t.bill = b;
    if (!Object.hasOwn(input, 'planDate') && (!previous || previous.dueDate !== t.dueDate)) t.planDate = addDays(t.dueDate, -b.remindDays);
  } else t.bill = null;
  if (t.source) {
    const source = t.source;
    if (typeof source !== 'object' || Array.isArray(source) || source.provider !== 'outlook') throw new Error('邮件来源格式不正确');
    const clean = { provider: 'outlook' };
    for (const k of ['key', 'messageId', 'subject', 'sender', 'receivedAt', 'url', 'excerpt', 'confidence', 'proposedStatus', 'proposedDueDate']) {
      if (source[k] !== undefined && typeof source[k] !== 'string') throw new Error('邮件来源字段不正确');
      clean[k] = String(source[k] || '').slice(0, k === 'url' ? 4000 : k === 'excerpt' ? 800 : 1000);
    }
    if (!clean.key || !clean.messageId || !clean.receivedAt || Number.isNaN(Date.parse(clean.receivedAt))) throw new Error('邮件来源缺少标识或日期');
    if (clean.url && !/^https:\/\//i.test(clean.url)) throw new Error('原邮件链接必须使用 HTTPS');
    if (!['high', 'review'].includes(clean.confidence) || !['todo', 'waiting'].includes(clean.proposedStatus)) throw new Error('邮件建议状态不正确');
    if (!validDate(clean.proposedDueDate)) throw new Error('邮件建议日期不正确');
    t.source = clean;
  }
  if(t.completionEvidence){const e=t.completionEvidence;if(typeof e!=='object'||!e.messageId||!e.excerpt||!/^https:\/\//.test(e.url||'')||Number.isNaN(Date.parse(e.receivedAt)))throw new Error('完成证据格式不正确');t.completionEvidence={provider:'outlook',messageId:String(e.messageId).slice(0,1000),url:String(e.url).slice(0,4000),receivedAt:e.receivedAt,excerpt:String(e.excerpt).slice(0,1000),reason:String(e.reason||'').slice(0,1000),automatic:e.automatic===true};}
  if(t.status!=='done')t.completionEvidence=null;
  return t;
}
export function inferProject(text) {
  const rules = [
    ['教学', /canvas|课程|上课|教学|quiz|作业|考试|cms6001|公告|\bcourse\b|\bteaching\b|\bexam\b|\blecture\b/i],
    ['科研申请', /ppr|深港|申请书|基金|proposal|stic|rgc|科研|摘要|版权|助盲/i],
    ['行政报销', /报销|收据|预算|账单|行政|表格|配额|reimbursement|receipt|budget|expense|\bform\b/i],
    ['学生事务', /学生|viva|答辩|指导|aa meeting|panel|student|advising|supervision/i],
    ['合作交流', /seminar|合作|来访|访问|samantha|holly|cathy|邀请|collaborat|visit|invitation/i],
    ['个人事务', /个人|买|缴费|预约|家里|生活|体检|出行|\bpersonal\b|\bhome\b|\bwater bill\b|\bgas bill\b|\belectricity bill\b|groceries|dentist/i],
  ];
  return rules.find(([, re]) => re.test(text))?.[0] || '科研申请';
}
export function parseTask(text, day = today()) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('先写下要做的事情');
  const original = text.trim();
  let date = '', datePhrase = '';
  const explicit = original.match(/(?:\d{4}-\d{1,2}-\d{1,2})|(?:\d{1,2}月\d{1,2}[日号]?)/);
  if (explicit) {
    datePhrase = explicit[0];
    if (datePhrase.includes('-')) date = datePhrase.split('-').map((v, i) => i ? v.padStart(2, '0') : v).join('-');
    else { const m = datePhrase.match(/(\d+)月(\d+)/); date = `${day.slice(0, 4)}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
    if (!validDate(date)) throw new Error('这条日期无效，请检查后重新输入');
  } else {
    const relative = original.match(/大后天|后天|明天|今天|(?:下|本|这)?(?:周|星期)[一二三四五六日天]/);
    if (relative) {
      datePhrase = relative[0];
      const offset = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 }[datePhrase];
      if (offset !== undefined) date = addDays(day, offset);
      else {
        const target = '一二三四五六日'.indexOf(datePhrase.at(-1).replace('天', '日'));
        const current = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
        let delta = target - current;
        if (datePhrase.startsWith('下')) delta += 7;
        else if (delta < 0 && !/^[本这]/.test(datePhrase)) delta += 7;
        date = addDays(day, delta);
      }
    }
  }
  if(!datePhrase){
    const english=original.match(/\b(today|tomorrow|(?:(?:next|this)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i);
    if(english){
      datePhrase=english[0];const phrase=datePhrase.toLowerCase();
      if(phrase==='today'||phrase==='tomorrow')date=addDays(day,phrase==='today'?0:1);
      else {const target=['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].indexOf(phrase.split(' ').at(-1));const current=(new Date(day+'T12:00:00Z').getUTCDay()+6)%7;let delta=target-current;if(phrase.startsWith('next '))delta+=7;else if(delta<0&&!phrase.startsWith('this '))delta+=7;date=addDays(day,delta);}
    }
  }
  const waiting = /等.{0,35}(回复|回信|确认)|等待|等候|\b(?:waiting for|awaiting|wait for)\b/i.test(original);
  const deadline = /截止|之前|前完成|前提交|前改|前发|前交|到期|最迟|\b(?:by|due|deadline)\b/i.test(original) || (datePhrase && original.includes(`${datePhrase}前`));
  let title = original.replace(/^(?:请帮我记下|帮我记下|帮我记|记下|添加|新增)[：:\s]*/, '').replace(/[，,\s]*(?:重要|紧急)[。！!]?$/, '').trim();
  // Keep date phrases in the title: no information is discarded by inference.
  if (!title) title = original;
  return { title, project: inferProject(original), priority: /重要|紧急|务必|必须|\b(?:important|urgent)\b/i.test(original) ? 'high' : 'normal', status: waiting ? 'waiting' : 'todo', planDate: waiting ? day : (deadline ? day : date || day), dueDate: deadline ? date : '', followUpDate: waiting ? date || addDays(day, 2) : '', notes: '', link: '', steps: [] };
}
export function briefing(tasks, day = today()) {
  const open = tasks.filter(t => !t.deletedAt && ['todo', 'waiting'].includes(t.status));
  const overdue = open.filter(t => effectiveDueDate(t) && effectiveDueDate(t) < day);
  const due = open.filter(t => effectiveDueDate(t) === day);
  const follow = open.filter(t => t.status === 'waiting' && t.followUpDate <= day);
  const choices = sorted(open.filter(t => isToday(t, day)), day).slice(0, 3);
  return { overdue: overdue.length, due: due.length, follow: follow.length, choices,
    message: !open.length ? '清空脑中的待办，从记下一件事开始。' : overdue.length ? `有 ${overdue.length} 件事项已过截止日期，先检查是否需要补救或重新协商。` : due.length ? `今天有 ${due.length} 件事项截止，先为它们留出时间。` : follow.length ? `有 ${follow.length} 件等待事项到跟进日期了，发个简短提醒即可推进。` : '先挑三件值得完成的事，其余事项会继续保留。' };
}
