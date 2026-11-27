/**
 * Тест логики мандата. Запуск: node test/mandate.test.mjs
 *
 * Проверяет боевой код: импортирует apply из index.js бандла и вызывает
 * зарегистрированную секцию с разными AssembleContext, как это делает
 * dsh-agent (assembleContextFor).
 *
 * Тест обязан уметь падать. Проверка невакуумности: см. mutate-check ниже —
 * с выключенным фильтром глубины тест «ребёнок не получает мандат» падает.
 */
import assert from 'node:assert/strict';
import { apply, name, inject } from '../index.js';

/** Собрать секцию так, как это делает DSH: через ctx.systemPrompt.section(). */
function captureSection(config, { toolVisible = true, withToolsService = true } = {}) {
  let captured;
  const ctx = {
    systemPrompt: {
      section(definition) {
        captured = definition;
        return () => {};
      },
    },
    // tools нужен и для проверки видимости инструмента, и для guard().
    // agentPresets отдаёт ТЕКУЩИЙ режим из presetsOf — как боевой Host-сервис.
    get(service) {
      if (service === 'agentPresets') {
        return presetsOf === undefined ? undefined : { composedPreset: () => presetsOf };
      }
      if (service !== 'tools' || !withToolsService) return undefined;
      return {
        guard() { return () => {}; },
        get() {
          return toolVisible ? { name: 'subagent' } : undefined;
        },
      };
    },
    on() { return () => {}; },
  };
  apply(ctx, config);
  assert.ok(captured, 'apply() должен зарегистрировать секцию');
  return captured;
}

/** Контекст сборки с заданными агентом и глубиной. */
function contextWith({ provider, headerDepth, runtimeDepth, agent = true } = {}) {
  if (!agent) return {};
  return {
    agent: {
      options: {
        provider,
        ...runtimeDepth === undefined ? {} : { subagentDepth: runtimeDepth },
      },
      session: {
        header: headerDepth === undefined ? {} : { delegationDepth: headerDepth },
      },
      // Второй путь чтения режима: через контекст самого агента.
      ctx: {
        get(service) {
          return service === 'agentPresets' && presetsOf !== undefined
            ? { composedPreset: () => presetsOf }
            : undefined;
        },
      },
    },
  };
}

/** Режим, который видит мандат. undefined — реестр недоступен. */
let presetsOf = 'standard';

/** Переключить режим, который видит мандат. */
function usePreset(id) {
  presetsOf = id;
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

const section = captureSection({ enabled: true });

console.log('Плагин: name=' + name + ' inject=' + JSON.stringify(inject));
assert.equal(name, 'free-delegation', 'имя плагина');
assert.deepEqual(inject, ['systemPrompt', 'tools'], 'инъекция сервисов');

console.log('');
console.log('1. Мандат выдаётся корневому облачному агенту');
check('корень без depth -> текст есть', () => {
  const text = section.text(contextWith({ provider: 'aiai-by' }));
  assert.ok(text.length > 0, 'мандат должен быть непустым');
  assert.match(text, /subagent/, 'мандат должен называть инструмент subagent');
  assert.match(text, /aiai-by/, 'мандат должен называть провайдера исполнителя');
  assert.match(text, /solar-mini-4-5/, 'мандат должен называть модель исполнителя');
});

check('корень с явным depth 0 -> текст есть', () => {
  const text = section.text(contextWith({ provider: 'aiai-by', headerDepth: 0, runtimeDepth: 0 }));
  assert.ok(text.length > 0, 'мандат должен быть непустым');
});

console.log('');
console.log('2. Дети мандат НЕ получают (главная защита от противоречия)');
check('depth 1 из заголовка сессии -> пусто', () => {
  const text = section.text(contextWith({ provider: 'our-free-model', headerDepth: 1 }));
  assert.equal(text, '', 'ребёнок не должен получать мандат');
});

check('depth 2 -> пусто', () => {
  const text = section.text(contextWith({ provider: 'our-free-model', headerDepth: 2 }));
  assert.equal(text, '', 'глубокий ребёнок не должен получать мандат');
});

check('depth 1 только в runtime-опции -> пусто', () => {
  const text = section.text(contextWith({ provider: 'our-free-model', runtimeDepth: 1 }));
  assert.equal(text, '', 'runtime-глубина тоже должна блокировать мандат');
});

check('runtime-глубина углубляет счёт (монотонность) -> пусто', () => {
  // Заголовок говорит 0, runtime говорит 1: побеждает максимум.
  const text = section.text(contextWith({ provider: 'our-free-model', headerDepth: 0, runtimeDepth: 1 }));
  assert.equal(text, '', 'runtime-опция может только углубить счёт');
});

console.log('');
console.log('3. Локальный корень мандат НЕ получает');
for (const provider of ['ollama-local', 'lmstudio-local']) {
  check('provider ' + provider + ' -> пусто', () => {
    const text = section.text(contextWith({ provider }));
    assert.equal(text, '', 'локальный корень не принуждаем');
  });
}

console.log('');
console.log('4. Сборка без агента мандат НЕ получает');
check('пустой контекст -> пусто', () => {
  assert.equal(section.text({}), '', 'registry-only сборка никому не адресована');
});
check('agent: undefined -> пусто', () => {
  assert.equal(section.text({ agent: undefined }), '', 'без агента мандата нет');
});

console.log('');
console.log('5. Конфигурация уважается');
check('enabled: false -> секция не регистрируется', () => {
  let registered = false;
  apply({ systemPrompt: { section() { registered = true; return () => {}; } } }, { enabled: false });
  assert.equal(registered, false, 'выключенный плагин не должен регистрировать секцию');
});

check('свой localProviders -> чужой провайдер получает мандат', () => {
  const custom = captureSection({ enabled: true, localProviders: ['my-local'] });
  assert.equal(custom.text(contextWith({ provider: 'ollama-local' })).length > 0, true,
    'ollama-local не в списке -> мандат выдаётся');
  assert.equal(custom.text(contextWith({ provider: 'my-local' })), '',
    'my-local в списке -> мандата нет');
});

check('свой executor -> подставляется в текст', () => {
  const custom = captureSection({ enabled: true, executor: { provider: 'my-provider', model: 'my-model' } });
  const text = custom.text(contextWith({ provider: 'aiai-by' }));
  assert.match(text, /my-provider/, 'свой provider должен попасть в текст');
  assert.match(text, /my-model/, 'своя model должна попасть в текст');
  assert.doesNotMatch(text, /solar-mini-4-5/, 'умолчание не должно остаться');
});

check('пустой executor -> берётся умолчание', () => {
  const custom = captureSection({ enabled: true, executor: {} });
  assert.match(custom.text(contextWith({ provider: 'aiai-by' })), /aiai-by/,
    'пустой executor должен откатиться к умолчанию');
});

check('испорченный executor -> берётся умолчание', () => {
  const custom = captureSection({ enabled: true, executor: { provider: 42, model: null } });
  const text = custom.text(contextWith({ provider: 'aiai-by' }));
  assert.match(text, /solar-mini-4-5/, 'нестроковый executor должен откатиться к умолчанию');
});

check('мандат называет единственного исполнителя и запрещает перебор', () => {
  const text = section.text(contextWith({ provider: 'aiai-by' }));
  assert.match(text, /РОВНО ОДИН/, 'мандат обязан объявить единственного исполнителя');
  assert.match(text, /Не выбирай других исполнителей/, 'перебор маршрутов должен быть запрещён');
});

console.log('');
console.log('6. Устойчивость к повреждённым данным');
check('мусорная глубина -> считается корнем, не бросает', () => {
  const text = section.text(contextWith({ provider: 'aiai-by', headerDepth: -5, runtimeDepth: 3.7 }));
  assert.ok(typeof text === 'string', 'текст должен быть строкой');
});
check('session отсутствует -> не бросает', () => {
  const text = section.text({ agent: { options: { provider: 'aiai-by' } } });
  assert.ok(typeof text === 'string', 'отсутствие session не должно ломать');
});

console.log('');
console.log('7. Агент без инструмента делегирования мандат НЕ получает');
check('subagent не виден -> пусто (пресет minimal)', () => {
  const bare = captureSection({ enabled: true }, { toolVisible: false });
  assert.equal(bare.text(contextWith({ provider: 'aiai-by' })), '',
    'приказ вызвать отсутствующий инструмент недопустим');
});
check('subagent виден -> текст есть', () => {
  const withTool = captureSection({ enabled: true }, { toolVisible: true });
  assert.ok(withTool.text(contextWith({ provider: 'aiai-by' })).length > 0,
    'при видимом инструменте мандат выдаётся');
});
check('сервис tools отсутствует -> мандат не теряется', () => {
  const noService = captureSection({ enabled: true }, { withToolsService: false });
  assert.ok(noService.text(contextWith({ provider: 'aiai-by' })).length > 0,
    'без сервиса tools проверка невозможна, мандат остаётся');
});

console.log('');
console.log('8. Порядок и отставка секции');
check('order задан числом', () => {
  assert.equal(Number.isFinite(section.order), true, 'order должен быть числом');
});
check('retirement задан', () => {
  assert.ok(typeof section.retirement === 'string' && section.retirement.length > 0,
    'отставка секции должна быть описана');
});

console.log('');
console.log('9. Жёсткое правило действует ТОЛЬКО в режимах standard и lead');
for (const preset of ['standard', 'lead']) {
  check('режим ' + preset + ' -> мандат есть', () => {
    usePreset(preset);
    const text = section.text(contextWith({ provider: 'aiai-by' }));
    assert.ok(text.length > 0, 'в разрешённом режиме мандат обязателен');
  });
}
for (const preset of ['cordis', 'ptc', 'minimal', 'cabinet']) {
  check('режим ' + preset + ' -> мандата нет', () => {
    usePreset(preset);
    assert.equal(section.text(contextWith({ provider: 'aiai-by' })), '',
      'вне standard/lead жёсткое правило не действует');
  });
}
check('режим не определён -> мандата нет', () => {
  usePreset(undefined);
  assert.equal(section.text(contextWith({ provider: 'aiai-by' })), '',
    'неопознанный режим не должен получать жёсткое правило');
});
check('свой список режимов уважается', () => {
  const custom = captureSection({ enabled: true, mandatePresets: ['ptc'] });
  usePreset('ptc');
  assert.ok(custom.text(contextWith({ provider: 'aiai-by' })).length > 0,
    'явно названный режим должен получать мандат');
  usePreset('standard');
  assert.equal(custom.text(contextWith({ provider: 'aiai-by' })), '',
    'standard не назван -> мандата нет');
});
usePreset('standard');

console.log('');
console.log('10. Правило дробления задач и ответственности главной модели');
check('запрет отдавать сложную задачу целиком', () => {
  const text = section.text(contextWith({ provider: 'aiai-by' }));
  assert.match(text, /Не давай субагенту сложную задачу целиком/,
    'мандат обязан запрещать целую сложную задачу');
  assert.match(text, /ПО ОДНОМУ шагу/, 'шаг должен выдаваться по одному');
});
check('требование контроля каждого шага', () => {
  const text = section.text(contextWith({ provider: 'aiai-by' }));
  assert.match(text, /Контролируй каждый шаг/, 'контроль шагов обязателен');
});
check('ответственность за результат на главной модели', () => {
  const text = section.text(contextWith({ provider: 'aiai-by' }));
  assert.match(text, /За результат отвечает главная модель/,
    'ответственность должна быть на корневой модели');
  assert.match(text, /Нельзя ссылаться на «субагент сказал»/,
    'ссылка на субагента как на оправдание запрещена');
});

console.log('');
console.log('11. Два исполнителя: дешёвая по умолчанию, вторая на подъём');
const two = captureSection({
  enabled: true,
  executor: { provider: 'aiai-by', model: 'solar-mini-4-5' },
  escalation: { provider: 'aiai-by', model: 'hy4-flash' },
});
const twoText = two.text(contextWith({ provider: 'aiai-by' }));

check('оба маршрута названы в мандате', () => {
  assert.match(twoText, /solar-mini-4-5/, 'дешёвая должна быть названа');
  assert.match(twoText, /hy4-flash/, 'вторая должна быть названа');
});
check('правило единственного исполнителя снято', () => {
  assert.doesNotMatch(twoText, /РОВНО ОДИН/, 'при двух маршрутах правило одного не действует');
  assert.doesNotMatch(twoText, /Не выбирай других исполнителей/, 'запрет перебора снимается');
});
check('сказано, что дешёвая — по умолчанию', () => {
  assert.match(twoText, /Исполнителей у тебя ДВА/, 'мандат обязан объявить два маршрута');
  assert.match(twoText, /По умолчанию — дешёвая/, 'дешёвая должна быть приоритетом');
});
check('есть критерии выбора между ними', () => {
  assert.match(twoText, /Отдавай дешёвой/, 'нужен список для дешёвой');
  assert.match(twoText, /Ставь сразу второй/, 'нужен список для второй');
  assert.match(twoText, /сложная логика/i, 'сложная логика — повод подъёма');
  assert.match(twoText, /изображения/, 'зрение — повод подъёма');
  assert.match(twoText, /524K/, 'окно контекста — повод подъёма');
});
check('третьих маршрутов нет', () => {
  assert.match(twoText, /Третьих маршрутов нет/, 'перебор сверх двух запрещён');
});
check('escalation совпал с executor -> считается отсутствующим', () => {
  const same = captureSection({
    enabled: true,
    executor: { provider: 'aiai-by', model: 'solar-mini-4-5' },
    escalation: { provider: 'aiai-by', model: 'solar-mini-4-5' },
  });
  const text = same.text(contextWith({ provider: 'aiai-by' }));
  assert.match(text, /РОВНО ОДИН/, 'одинаковые маршруты — это один исполнитель, а не два');
});
check('escalation без полей -> подставляется умолчание', () => {
  const partial = captureSection({ enabled: true, escalation: {} });
  const text = partial.text(contextWith({ provider: 'aiai-by' }));
  assert.match(text, /hy4-flash/, 'пустой escalation откатывается к умолчанию');
});
check('escalation: null -> режим одного исполнителя', () => {
  const off = captureSection({ enabled: true, escalation: null });
  const text = off.text(contextWith({ provider: 'aiai-by' }));
  assert.match(text, /РОВНО ОДИН/, 'null отключает второй маршрут');
  assert.doesNotMatch(text, /hy4-flash/, 'вторая модель не должна упоминаться');
});
check('приёмка: пример с ъ/ь упомянут в обоих режимах', () => {
  assert.match(twoText, /pod-ezd/, 'двухрежимный мандат обязан нести пример приёмки');
  const oneText = section.text(contextWith({ provider: 'aiai-by' }));
  assert.match(oneText, /pod-ezd/, 'однорежимный мандат тоже несёт пример приёмки');
});

console.log('');
console.log('12. Экономия токенов дорогой модели (закон из роли «Руководитель»)');
// Нормы перенесены из роли «Руководитель» (~/.dsh/dsh-role-prompts.md) и
// обязаны действовать в ОБОИХ режимах: и при одном исполнителе, и при двух.
for (const [label, text] of [
  ['два исполнителя', twoText],
  ['один исполнитель', section.text(contextWith({ provider: 'aiai-by' }))],
]) {
  check(label + ': мандат объявлен законом, а не советом', () => {
    assert.match(text, /Закон роли, а не совет/, 'мандат обязан называть себя законом');
  });
  check(label + ': вся тяжёлая работа уходит исполнителю', () => {
    assert.match(text, /Вся тяжесть — исполнителю/, 'тяжёлый материал не должен оседать у корня');
    assert.match(text, /СЖАТЫЙ итог/, 'исполнитель обязан отдавать сжатый итог');
  });
  check(label + ': сырьё читается только по необходимости', () => {
    assert.match(text, /Сырьё читаешь только там/, 'чтение сырья корнем ограничено');
  });
  check(label + ': запрещён пересказ процесса в ответе', () => {
    assert.match(text, /Не пересказывай процесс/, 'ответ пользователю не должен пересказывать ход работы');
  });
  check(label + ': независимые задачи — одной пачкой', () => {
    assert.match(text, /одной пачкой в одном сообщении/, 'параллельные задачи ставятся одной пачкой');
  });
  check(label + ': нумерация цела после вставки норм', () => {
    assert.match(text, /10\. \*\*Вся тяжесть/, 'пункт 10 — экономия токенов');
    assert.match(text, /12\. Результат принимай по факту/, 'пункт 12 — приёмка по факту');
    assert.match(text, /14\. \*\*Не пересказывай процесс/, 'пункт 14 — короткий ответ');
  });
}

console.log('');
console.log('13. Оркестрация веера: workflow, без дублей и без опроса (уроки 27.11.2026)');
for (const [label, text] of [
  ['два исполнителя', twoText],
  ['один исполнитель', section.text(contextWith({ provider: 'aiai-by' }))],
]) {
  check(label + ': однотипный веер идёт через workflow', () => {
    assert.match(text, /запускай их `workflow`/, 'большой веер обязан идти скриптом');
    assert.match(text, /больше пяти/, 'нужен порог, с которого переходишь на workflow');
  });
  check(label + ': запрещено дублировать длинную инструкцию', () => {
    assert.match(text, /Не дублируй длинную инструкцию/, 'повтор правил в каждом вызове запрещён');
  });
  check(label + ': отчёт исполнителя ограничен по форме', () => {
    assert.match(text, /Ограничивай отчёт исполнителя/, 'отчёт обязан быть сжатым');
    assert.match(text, /Сделано: …/, 'задана конкретная форма отчёта');
  });
  check(label + ': запрещён опрос ожидания', () => {
    assert.match(text, /Не опрашивай ожидание/, 'крутить wait_agent подряд запрещено');
  });
  check(label + ': приведены замеры урока', () => {
    assert.match(text, /91 субагент/, 'нужен факт про 91 субагента');
    assert.match(text, /94 000 токенов|117 000 токенов/, 'нужны замеры токенов');
  });
  check(label + ': нумерация цела', () => {
    assert.match(text, /15\. \*\*Однотипных задач/, 'пункт 15 — workflow');
    assert.match(text, /18\. \*\*Не опрашивай ожидание/, 'пункт 18 — ожидание');
  });
  check(label + ': запрещено повторять вызов с теми же аргументами', () => {
    assert.match(text, /Повтор вызова с теми же аргументами запрещён/,
      'нужен пункт о повторных вызовах');
    assert.match(text, /Repeated tool call detected/, 'нужна цитата предупреждения платформы');
  });
  check(label + ': запрещено завершать цель по своей инициативе', () => {
    assert.match(text, /Цель не завершай по своей инициативе/,
      'нужен пункт о goal');
    assert.match(text, /direct human turn or the current goal round/,
      'нужна дословная формулировка правила платформы');
    assert.match(text, /20\. \*\*Цель не завершай/, 'пункт 20 — goal');
  });
}

console.log('');
console.log(`Итог: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
