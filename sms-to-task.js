// Twilio Function: receives a text, parses it into task(s) with Claude, and saves them to Supabase.
//
// Environment variables (set in Twilio Functions → Settings → Environment Variables):
//   SUPABASE_URL          https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  service_role key (Supabase → Project Settings → API). Keep secret.
//   MY_PHONE              your cell in E.164 format, e.g. +15035551234 (only this number can add tasks)
//   ANTHROPIC_API_KEY     optional; without it, the whole text becomes the task title
//   CLAUDE_MODEL          optional; defaults to claude-haiku-5-5
//   TIMEZONE              optional; defaults to America/Los_Angeles
//   REPLY_ENABLED         "true" once your number's A2P registration is approved, to get confirmation texts

const CATEGORIES = ['work', 'personal', 'errands', 'ideas'];
const PRIORITIES = ['low', 'normal', 'high'];

exports.handler = async function (context, event, callback) {
  const twiml = new Twilio.twiml.MessagingResponse();
  const reply = (msg) => {
    if (context.REPLY_ENABLED === 'true' && msg) twiml.message(msg);
    return callback(null, twiml);
  };

  try {
    // Ignore anyone who isn't you.
    if (normalize(event.From) !== normalize(context.MY_PHONE)) return reply(null);

    const text = (event.Body || '').trim();
    if (!text) return reply(null);

    // Opt-in keywords (double opt-in flow registered with carriers); these never become tasks
    const keyword = text.toUpperCase();
    if (keyword === 'TASKS') {
      return reply('Welcome to Tasks! You\'ll get a confirmation each time you text a task to this number. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. Terms & Privacy: blendedwaffle.github.io/tasks/sms-policy.html Reply Y to confirm.');
    }
    if (keyword === 'Y' || keyword === 'YES') {
      return reply('You\'re all set! Text any task to add it to your board.');
    }

    const tasks = await parseTasks(context, text);

    const res = await fetch(`${context.SUPABASE_URL}/rest/v1/tasks`, {
      method: 'POST',
      headers: {
        apikey: context.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${context.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(tasks.map((t) => ({ ...t, source: 'sms', raw_text: text }))),
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);

    const names = tasks.map((t) => t.title).join(', ');
    return reply(tasks.length === 1 ? `Added: ${names}` : `Added ${tasks.length}: ${names}`);
  } catch (err) {
    console.error(err);
    return reply('Couldn’t save that one. Try again in a minute.');
  }
};

// Turns a text into one or more clean tasks. Falls back to the raw text if Claude is unavailable.
async function parseTasks(context, text) {
  const fallback = [{ title: text.slice(0, 200), category: 'personal', priority: 'normal', due_date: null, notes: null }];
  if (!context.ANTHROPIC_API_KEY) return fallback;

  const tz = context.TIMEZONE || 'America/Los_Angeles';
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now); // YYYY-MM-DD
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);

  const system = `You turn a quick text message into to-do items. Today is ${weekday}, ${today}.
Return ONLY a JSON array, no prose, no code fences. Each item:
{"title": short imperative task, capitalized, no date words,
 "category": one of ${JSON.stringify(CATEGORIES)},
 "priority": one of ${JSON.stringify(PRIORITIES)} (high only if the text signals urgency or importance),
 "due_date": "YYYY-MM-DD" resolved from words like "friday" or "tmrw", else null,
 "notes": any extra detail worth keeping, else null}
Split into multiple items only when the text clearly lists separate tasks.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': context.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: context.CLAUDE_MODEL || 'claude-haiku-5-5',
        max_tokens: 600,
        system,
        messages: [{ role: 'user', content: text }],
      }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}`);
    const data = await res.json();
    const raw = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    const items = (Array.isArray(parsed) ? parsed : [parsed]).map(clean).filter(Boolean);
    return items.length ? items : fallback;
  } catch (err) {
    console.error('Parse failed, using raw text:', err.message);
    return fallback;
  }
}

// Keeps only valid values so a bad parse can't break the insert.
function clean(t) {
  if (!t || typeof t.title !== 'string' || !t.title.trim()) return null;
  return {
    title: t.title.trim().slice(0, 200),
    category: CATEGORIES.includes(t.category) ? t.category : 'personal',
    priority: PRIORITIES.includes(t.priority) ? t.priority : 'normal',
    due_date: /^\d{4}-\d{2}-\d{2}$/.test(t.due_date || '') ? t.due_date : null,
    notes: typeof t.notes === 'string' && t.notes.trim() ? t.notes.trim() : null,
  };
}

function normalize(num) {
  return String(num || '').replace(/[^\d]/g, '').replace(/^1(?=\d{10}$)/, '');
}
