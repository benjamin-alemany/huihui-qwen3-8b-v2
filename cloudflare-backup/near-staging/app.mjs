import { verifiedReply, verifyStagingModel } from './client.mjs';

const get = id => document.getElementById(id);
const composer = get('composer');
const input = get('message');
const send = get('send');
const notice = get('notice');
const verify = get('verify');
const messages = [];
let busy = false;

function append(role, content) {
  get('empty')?.remove();
  const article = document.createElement('article');
  article.dataset.role = role;
  const label = document.createElement('strong');
  label.textContent = role === 'user' ? 'You' : 'Qwen';
  const text = document.createElement('p');
  text.textContent = content;
  article.append(label, text);
  get('messages').append(article);
}

function update() {
  input.disabled = send.disabled = busy || messages.length >= 4;
  verify.disabled = busy;
}

verify.addEventListener('click', async () => {
  busy = true;
  update();
  notice.textContent = 'Checking fresh gateway and model evidence…';
  try {
    await verifyStagingModel(location.origin);
    notice.textContent = 'Gateway and model evidence verified. No chat request was sent.';
  } catch (error) {
    const code = error?.failure?.code;
    const status = error?.failure?.details?.status;
    const resource = error?.failure?.details?.resource;
    const diagnostic = typeof code === 'string' && /^[a-z_]+\.[a-z_]+$/.test(code) ? ' ' + code : '';
    notice.textContent = 'Model evidence could not be verified.' + diagnostic + (/^[a-z_]+$/.test(resource ?? '') ? ' ' + resource : '') + (Number.isInteger(status) ? ' HTTP ' + status : '');
  } finally {
    busy = false;
    update();
  }
});

composer.addEventListener('submit', async event => {
  event.preventDefault();
  const content = input.value.trim();
  if (!content || busy || messages.length >= 4) return;
  busy = true;
  update();
  notice.textContent = 'Verifying fresh model evidence and requesting an encrypted reply…';
  const user = {role: 'user', content};
  try {
    const answer = await verifiedReply(location.origin, [...messages, user]);
    messages.push(user, {role: 'assistant', content: answer});
    append('user', content);
    append('assistant', answer);
    input.value = '';
    notice.textContent = messages.length === 4 ? 'Two verified replies received.' : 'Model signature verified. Send your follow-up.';
  } catch {
    notice.textContent = 'No verified reply. Your draft is still in this tab.';
  } finally {
    busy = false;
    update();
  }
});

addEventListener('pagehide', () => {
  messages.length = 0;
  composer.reset();
  get('messages').replaceChildren();
});

notice.textContent = 'Ready to check the first dummy message.';
update();
