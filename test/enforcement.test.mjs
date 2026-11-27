/**
 * Тесты технического принуждения делегирования.
 *
 * Запуск: node test/enforcement.test.mjs
 *
 * Проверяет БОЕВОЙ код: импортирует apply из index.js и вызывает
 * зарегистрированный guard так, как это делает dsh-tools (checkGuards),
 * а события — так, как их эмитит агентский цикл.
 *
 * Тест обязан уметь падать: см. mutation-check.mjs.
 */
import assert from 'node:assert/strict';
import { apply } from '../index.js';

/**
 * Собрать плагин в поддельном контексте и вернуть точки доступа:
 * зарегистрированный guard, функцию эмита событий и поддельный реестр.
 */
function harness(config = { enabled: true, enforce: true }, { expectGuard = true } = {}) {
  let guard;
  const listeners = new Map();
  const visibleTools = new Set([
    'subagent', 'read', 'write', 'edit', 'glob', 'grep', 'bash', 'present',
  ]);
  const tools = {
    guard(fn) { guard = fn; return () => { guard = undefined; }; },
    get(name) { return visibleTools.has(name) ? { name } : undefined; },
  };
  const ctx = {
    systemPrompt: { section() { return () => {}; } },
    get(service) {
      // host-путь: отдаёт ТЕКУЩИЙ режим из currentPreset, как боевой сервис.
      if (service === 'agentPresets') {
        return currentPreset === undefined ? undefined : { composedPreset: () => currentPreset };
      }
      return service === 'tools' ? tools : undefined;
    },
    on(event, fn) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return () => {};
    },
  };
  apply(ctx, config);
  if (expectGuard) assert.ok(typeof guard === 'function', 'apply() должен зарегистрировать guard');
  return {
    guard,
    tools,
    emit(event, payload) {
      for (const fn of listeners.get(event) ?? []) fn(payload);
    },
  };
}

/** Агент заданной глубины и провайдера. */
function agentOf({ provider = 'aiai-by', depth = 0, id = 'session-root' } = {}) {
  return {
    options: { provider },
    session: { id, header: depth === 0 ? {} : { delegationDepth: depth } },
    // Второй путь чтения режима: через контекст самого агента.
    ctx: {
      get(service) {
        return service === 'agentPresets' && currentPreset !== undefined
          ? { composedPreset: () => currentPreset }
          : undefined;
      },
    },
  };
}

/** Режим, который видит агент. undefined — реестр недоступен. */
let currentPreset = 'standard';

/** Вызов инструмента от имени агента. */
function call(name, agent) {
  return { name, agent };
}

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + label);
  } catch (error) {
    failed++;
    console.log('  FAIL ' + label + ' :: ' + error.message);
  }
}

console.log('1. Рабочий инструмент запрещён до делегирования');
{
  const h = harness();
  const root = agentOf();
  h.emit('agent/inbox/claimed', { agent: root, turn: 1 });
  for (const tool of ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'present']) {
    check(tool + ' запрещён', () => {
      const denial = h.guard(call(tool, root));
      assert.ok(denial !== undefined, tool + ' должен быть запрещён');
      assert.equal(typeof denial.reason, 'string');
      assert.match(denial.reason, /мандатом делегирования/);
      assert.equal(denial.info.code, 'DELEGATION_MANDATE_REQUIRED');
    });
  }
}

console.log('');
console.log('2. Инструмент делегирования НЕ запрещён (иначе тупик)');
{
  const h = harness();
  const root = agentOf();
  h.emit('agent/inbox/claimed', { agent: root, turn: 1 });
  check('subagent разрешён', () => {
    assert.equal(h.guard(call('subagent', root)), undefined);
  });
  check('list_subagent_models разрешён', () => {
    h.tools.get = name => (name === 'list_subagent_models' ? { name } : undefined);
    assert.equal(h.guard(call('list_subagent_models', root)), undefined);
  });
}

console.log('');
console.log('3. После делегирования инструменты разблокированы');
{
  const h = harness();
  const root = agentOf();
  h.emit('agent/inbox/claimed', { agent: root, turn: 1 });
  check('до делегирования read запрещён', () => {
    assert.ok(h.guard(call('read', root)) !== undefined);
  });
  h.emit('subagent/start', { parentSessionId: 'session-root' });
  check('после subagent/start read разрешён', () => {
    assert.equal(h.guard(call('read', root)), undefined);
  });
}

console.log('');
console.log('4. Уведомление о завершении субагента НЕ перезапирает инструменты');
{
  const h = harness();
  const root = agentOf();
  h.emit('agent/inbox/claimed', { agent: root, turn: 1 });
  h.emit('subagent/start', { parentSessionId: 'session-root' });
  // Повторное событие того же хода (доставка уведомления ребёнка) НЕ должно
  // аннулировать зачёт: номер хода не изменился.
  h.emit('agent/inbox/claimed', { agent: root, turn: 1 });
  check('тот же ход: read остаётся разрешён', () => {
    assert.equal(h.guard(call('read', root)), undefined,
      'уведомление субагента не должно перезапирать инструменты');
  });
}

console.log('');
console.log('5. Новый ход требует нового делегирования');
{
  const h = harness();
  const root = agentOf();
  h.emit('agent/inbox/claimed', { agent: root, turn: 1 });
  h.emit('subagent/start', { parentSessionId: 'session-root' });
  check('ход 1: read разрешён', () => {
    assert.equal(h.guard(call('read', root)), undefined);
  });
  h.emit('agent/inbox/claimed', { agent: root, turn: 2 });
  check('ход 2: read снова запрещён', () => {
    assert.ok(h.guard(call('read', root)) !== undefined, 'новый ход требует делегирования');
  });
  h.emit('subagent/start', { parentSessionId: 'session-root' });
  check('ход 2 после делегирования: read разрешён', () => {
    assert.equal(h.guard(call('read', root)), undefined);
  });
}

console.log('');
console.log('6. Самоблокировка невозможна: попытка делегирования зачитывается');
{
  const h = harness();
  const root = agentOf();
  h.emit('agent/inbox/claimed', { agent: root, turn: 1 });
  check('до попытки read запрещён', () => {
    assert.ok(h.guard(call('read', root)) !== undefined);
  });
  // Запуск ребёнка упал (маршрут не разрешён / лимит) — subagent/start не был,
  // но tools/result пришёл.
  h.emit('tools/result', call('subagent', root));
  check('после неудачной попытки read разрешён (нет тупика)', () => {
    assert.equal(h.guard(call('read', root)), undefined,
      'иначе сессия осталась бы без инструментов и без делегирования');
  });
}

console.log('');
console.log('7. Дети и локальные корни принуждением не затрагиваются');
{
  const h = harness();
  const child = agentOf({ provider: 'our-free-model', depth: 1, id: 'session-child' });
  h.emit('agent/inbox/claimed', { agent: child, turn: 1 });
  check('ребёнок (depth 1): read разрешён', () => {
    assert.equal(h.guard(call('read', child)), undefined,
      'ребёнок делегировать не может, принуждать его нельзя');
  });
  const local = agentOf({ provider: 'ollama-local', id: 'session-local' });
  h.emit('agent/inbox/claimed', { agent: local, turn: 1 });
  check('локальный корень: read разрешён', () => {
    assert.equal(h.guard(call('read', local)), undefined);
  });
}

console.log('');
console.log('8. PTC-режим исключён из принуждения');
{
  const h = harness();
  const root = agentOf();
  h.tools.get = name => (name === 'run_code' || name === 'read' ? { name } : undefined);
  h.emit('agent/inbox/claimed', { agent: root, turn: 1 });
  check('виден run_code: read НЕ запрещён', () => {
    assert.equal(h.guard(call('read', root)), undefined,
      'в PTC делегирование возможно только изнутри run_code');
  });
}

console.log('');
console.log('9. Незнакомый инструмент не запрещается (список запрещающий)');
{
  const h = harness();
  const root = agentOf();
  h.emit('agent/inbox/claimed', { agent: root, turn: 1 });
  check('новый инструмент из другого бандла разрешён', () => {
    assert.equal(h.guard(call('some_future_tool', root)), undefined,
      'ошибка в списке не должна запирать сессию');
  });
}

console.log('');
console.log('10. Fail-open: повреждённый вызов не роняет сессию');
{
  const h = harness();
  check('вызов без агента', () => {
    assert.equal(h.guard({ name: 'read' }), undefined);
  });
  check('вызов без имени', () => {
    assert.equal(h.guard({ agent: agentOf() }), undefined);
  });
  check('вызов null', () => {
    assert.equal(h.guard(null), undefined);
  });
}

console.log('');
console.log('11. Выключение принуждения');
{
  // enforce: false — guard не регистрируется вовсе, это и проверяем.
  const h = harness({ enabled: true, enforce: false }, { expectGuard: false });
  const root = agentOf();
  h.emit('agent/inbox/claimed', { agent: root, turn: 1 });
  check('enforce: false — guard не зарегистрирован', () => {
    assert.equal(h.guard, undefined, 'выключенное принуждение не ставит guard');
  });
  check('enforce: false — рабочий инструмент не заблокирован ничем', () => {
    // Запрещать нечему: guard отсутствует, значит вызов проходит.
    assert.equal(h.guard, undefined);
  });
}

console.log('');
console.log('12. Принуждение действует ТОЛЬКО в режимах standard и lead');
for (const preset of ['standard', 'lead']) {
  check('режим ' + preset + ': read запрещён до делегирования', () => {
    currentPreset = preset;
    const h = harness();
    const root = agentOf();
    h.emit('agent/inbox/claimed', { agent: root, turn: 1 });
    assert.ok(h.guard(call('read', root)) !== undefined,
      'в разрешённом режиме принуждение обязательно');
  });
}
for (const preset of ['cordis', 'ptc', 'minimal', 'cabinet']) {
  check('режим ' + preset + ': read разрешён (принуждения нет)', () => {
    currentPreset = preset;
    const h = harness();
    const root = agentOf();
    h.emit('agent/inbox/claimed', { agent: root, turn: 1 });
    assert.equal(h.guard(call('read', root)), undefined,
      'вне standard/lead жёсткое правило не действует');
  });
}
check('режим не определён: read разрешён', () => {
  currentPreset = undefined;
  const h = harness();
  const root = agentOf();
  h.emit('agent/inbox/claimed', { agent: root, turn: 1 });
  assert.equal(h.guard(call('read', root)), undefined,
    'неопознанный режим не должен запирать инструменты');
});
currentPreset = 'standard';

console.log('');
console.log(`Итог: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
