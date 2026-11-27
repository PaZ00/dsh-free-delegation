/**
 * Проверка невакуумности: каждый тест обязан падать на своём мутанте.
 *
 * Запуск: node test/mutation-check.mjs
 *
 * Логика: собираем мутантов из БОЕВОГО index.js (снимаем по одной защите),
 * прогоняем на каждом ОБА набора тестов и требуем, чтобы хотя бы один упал.
 * Зелёный прогон на мутанте означает, что защита тестами не покрыта — это
 * провал проверки, а не успех.
 *
 * Мутанты и раннеры — временные артефакты: файл убирает их за собой, в том
 * числе при падении.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const bundle = path.dirname(dir);
const source = fs.readFileSync(path.join(bundle, 'index.js'), 'utf8');

/** Наборы тестов, которые прогоняются на каждом мутанте. */
const SUITES = ['mandate.test.mjs', 'enforcement.test.mjs'];

/**
 * Мутант = боевой код с одной снятой защитой.
 * Якоря — точные строки боевого index.js; при рефакторинге их надо обновлять,
 * и скрипт падает громко, если якорь перестал находиться.
 */
const mutations = [
  {
    name: 'no-depth-filter',
    label: 'снят фильтр глубины (мандат выдавался бы детям)',
    apply: text => text.replace(
      '  if (delegationDepthOf(agent) !== 0) return false',
      '  // МУТАЦИЯ: фильтр глубины снят\n  void delegationDepthOf',
    ),
  },
  {
    name: 'no-local-filter',
    label: 'снят фильтр локальных провайдеров',
    apply: text => text.replace(
      "  if (typeof provider === 'string' && settings.localProviders.includes(provider)) return false",
      '  // МУТАЦИЯ: фильтр локальных провайдеров снят\n  void provider',
    ),
  },
  {
    name: 'no-tool-check',
    label: 'снята проверка видимости инструмента делегирования',
    apply: text => text.replace(
      '  if (tools.get(settings.toolName, scope) === undefined) return false',
      '  // МУТАЦИЯ: проверка видимости инструмента снята\n  void scope',
    ),
  },
  {
    name: 'no-preset-filter',
    label: 'снят фильтр режимов (мандат действовал бы в cordis и ptc)',
    apply: text => text.replace(
      '  if (preset === undefined || !settings.mandatePresets.includes(preset)) return false',
      '  // МУТАЦИЯ: фильтр режимов снят\n  void preset',
    ),
  },
  {
    name: 'no-deny-list',
    label: 'снят запрет рабочих инструментов (принуждение не работает)',
    apply: text => text.replace(
      "      if (typeof tool !== 'string' || !settings.deniedTools.includes(tool)) return undefined",
      '      // МУТАЦИЯ: запрет инструментов снят\n      return undefined',
    ),
  },
  {
    name: 'no-credit-check',
    label: 'снят зачёт делегирования (инструменты запираются навсегда)',
    apply: text => text.replace(
      '      if (entry !== undefined && entry.creditedTurn === entry.turn) return undefined',
      '      // МУТАЦИЯ: зачёт делегирования игнорируется\n      void entry',
    ),
  },
  {
    name: 'no-turn-binding',
    label: 'зачёт делегирования не привязан к ходу (хватило бы одного раза)',
    // Привязка к ходу держится ДВУМЯ механизмами: сбросом `creditedTurn` в
    // observeTurn и проверкой равенства в guard. Снятие любого одного
    // компенсируется вторым, поэтому мутация обязана снять ОБА — иначе она
    // проверяет не привязку к ходу, а избыточность защиты.
    apply: text => text
      .replace(
        '      if (entry !== undefined && entry.creditedTurn === entry.turn) return undefined',
        '      // МУТАЦИЯ: зачёт не привязан к ходу\n      if (entry !== undefined && entry.creditedTurn >= 0) return undefined',
      )
      .replace(
        '      entry.turn = turn\n      entry.creditedTurn = -1',
        '      // МУТАЦИЯ: зачёт не сбрасывается на новом ходу\n      entry.turn = turn',
      ),
  },
  {
    name: 'escalation-always-on',
    label: 'второй маршрут подставляется даже когда конфигурация его не задавала',
    // Снимает ветку «escalation объявлен и отличается от executor»: тогда
    // двухрежимный мандат выдавался бы и в однорежимной конфигурации, и тест
    // «escalation: null -> режим одного исполнителя» обязан это поймать.
    apply: text => text.replace(
      '  if (value === undefined || value === null) return undefined',
      '  // МУТАЦИЯ: отсутствие escalation игнорируется\n  if (false) return undefined',
    ),
  },
  {
    name: 'escalation-same-allowed',
    label: 'одинаковые маршруты считаются двумя исполнителями',
    // Снимает защиту от вырожденной конфигурации, где второй маршрут совпадает
    // с первым: мандат обещал бы выбор между одинаковыми моделями.
    apply: text => text.replace(
      '  if (provider === executor.provider && model === executor.model) return undefined',
      '  // МУТАЦИЯ: совпадение маршрутов разрешено\n  void executor',
    ),
  },
  {
    name: 'no-escalation-rules',
    label: 'из мандата выпали критерии выбора второго маршрута',
    // Снимает подсказки «когда поднимать»: остаётся упоминание двух моделей без
    // правил, и тест «есть критерии выбора между ними» обязан упасть.
    apply: text => text.replace(
      '**Ставь сразу второй**',
      '**(МУТАЦИЯ) Никогда не поднимай**',
    ),
  },
  {
    name: 'no-token-economy',
    label: 'из мандата выпал закон экономии токенов дорогой модели',
    // Снимает норму «вся тяжесть — исполнителю»: корень снова читал бы сырьё
    // в свой контекст, и тест раздела 12 обязан это поймать.
    apply: text => text.replace(
      '**Вся тяжесть — исполнителю.**',
      '**(МУТАЦИЯ) Читай сырьё сам.**',
    ),
  },
  {
    name: 'no-workflow-fanout',
    label: 'из мандата выпало правило веера через workflow',
    // Снимает требование запускать однотипный веер скриптом: корень снова
    // запускал бы десятки субагентов поодиночке, и раздел 13 обязан упасть.
    apply: text => text.replace(
      'запускай их `workflow`',
      '**(МУТАЦИЯ) запускай по одному**',
    ),
  },
  {
    name: 'no-wait-ban',
    label: 'из мандата выпал запрет опрашивать ожидание',
    // Снимает запрет на пустые таймауты — тест «запрещён опрос ожидания» упадёт.
    apply: text => text.replace(
      '**Не опрашивай ожидание.**',
      '**(МУТАЦИЯ) Опрашивай ожидание.**',
    ),
  },
  {
    name: 'no-repeat-ban',
    label: 'из мандата выпал запрет повторять вызов с теми же аргументами',
    // Снимает норму про повторные вызовы — тест раздела 13 обязан упасть.
    apply: text => text.replace(
      '**Повтор вызова с теми же аргументами запрещён.**',
      '**(МУТАЦИЯ) Повторяй вызов сколько угодно.**',
    ),
  },
  {
    name: 'no-goal-autonomy-ban',
    label: 'из мандата выпал запрет завершать цель по своей инициативе',
    // Снимает норму про goal — тест «запрещено завершать цель» упадёт.
    apply: text => text.replace(
      '**Цель не завершай по своей инициативе.**',
      '**(МУТАЦИЯ) Завершай цель когда захочешь.**',
    ),
  },
];

const created = [];
function cleanup() {
  for (const file of created) {
    try { fs.unlinkSync(file); } catch { /* уже убран */ }
  }
}

let failures = 0;
try {
  for (const mutation of mutations) {
    const mutated = mutation.apply(source);
    if (mutated === source) {
      failures++;
      console.log('ПРОВАЛ  ' + mutation.label + ': якорь мутации не найден в боевом коде');
      continue;
    }

    const mutantPath = path.join(bundle, 'test', '.mutant-' + mutation.name + '.mjs');
    fs.writeFileSync(mutantPath, mutated, 'utf8');
    created.push(mutantPath);

    let killed = false;
    const details = [];
    for (const suite of SUITES) {
      const testSource = fs.readFileSync(path.join(bundle, 'test', suite), 'utf8');
      const runnerPath = path.join(bundle, 'test', '.runner-' + mutation.name + '-' + suite);
      fs.writeFileSync(runnerPath, testSource.replace(
        "from '../index.js'",
        "from './.mutant-" + mutation.name + ".mjs'",
      ), 'utf8');
      created.push(runnerPath);

      let exitCode = 0;
      let output = '';
      try {
        output = execFileSync(process.execPath, [runnerPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        exitCode = error.status ?? 1;
        output = String(error.stdout ?? '') + String(error.stderr ?? '');
      }
      const failCount = (output.match(/FAIL/g) ?? []).length;
      details.push(suite + ':exit=' + exitCode + ',FAIL=' + failCount);
      if (exitCode !== 0) killed = true;
    }

    if (killed) {
      console.log('ок      ' + mutation.label + ' [' + details.join(' | ') + ']');
    } else {
      failures++;
      console.log('ПРОВАЛ  ' + mutation.label + ': мутант ВЫЖИЛ [' + details.join(' | ') + ']');
    }
  }
} finally {
  cleanup();
}

console.log('');
if (failures > 0) {
  console.log('Невакуумность НЕ подтверждена: провалов ' + failures);
  process.exit(1);
}
console.log('Невакуумность подтверждена: убито мутантов ' + mutations.length + ' из ' + mutations.length);
