/**
 * CL-7 規則化（#823）的三條 lint：10/19～21 同類問題出現兩次以上的，改成機器把關。
 * 反例與合法例在 `lint-fixtures/`，由 `pnpm lint:boundaries-test` 逐檔斷言。
 */

/** JSX 開頭標籤上的 `key`。 */
function hasKey(opening) {
  return opening.attributes.some((a) => a.type === 'JSXAttribute' && a.name.name === 'key')
}

function jsxAttr(opening, name) {
  return opening.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === name)
}

const isFunctionNode = (n) =>
  n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression'

/**
 * 用 `defaultValue`／`defaultChecked` 帶資料的欄位要有 `key`（C1-12、C3-07 同類兩次）。
 *
 * 不受控欄位只在第一次掛上時讀預設值；同一份資料被別的路徑改了（開關、換網址參數、別的分頁），
 * React 沿用舊的 DOM，畫面留著舊值，存回去就蓋掉別人的改動。欄位自己或外層任一元素帶 `key`
 * （例如 `${revision}-${欄位}`、搜尋框 `key={q}`），資料一變就重掛。
 *
 * 不管的：字面值（`defaultValue=""`）、原樣轉傳 prop（`defaultValue={defaultValue}`、`props.defaultValue`、
 * `x ?? defaultValue`）——由呼叫端那一行負責。只往上看到元件邊界；`.map(...)` 這類 callback 會繼續往外找。
 * 外層元件已經帶 key、這裡看不到的，用 `// eslint-disable-next-line fju/default-value-needs-key -- <哪裡帶了 key>`。
 */
const DEFAULT_PROPS = new Set(['defaultValue', 'defaultChecked'])

function isStaticValue(value) {
  if (!value || value.type === 'Literal') return true
  if (value.type !== 'JSXExpressionContainer') return false
  const e = value.expression
  return e.type === 'Literal' || (e.type === 'TemplateLiteral' && e.expressions.length === 0)
}

function isForwarded(expression) {
  if (!expression) return false
  if (expression.type === 'Identifier') return DEFAULT_PROPS.has(expression.name)
  if (expression.type === 'MemberExpression') {
    return !expression.computed && expression.property.type === 'Identifier' && DEFAULT_PROPS.has(expression.property.name)
  }
  if (expression.type === 'LogicalExpression') return isForwarded(expression.right)
  return false
}

export const defaultValueNeedsKey = {
  meta: {
    type: 'problem',
    docs: { description: '用 defaultValue／defaultChecked 帶資料的欄位要有 key' },
    schema: [],
    messages: {
      missingKey:
        '`{{name}}` 帶的是資料，欄位或外層元素要加 `key`（例如 `${revision}-${欄位}`、搜尋框 `key={q}`），資料變了才會重掛、不留舊值（前端慣例：舊狀態存回去）。',
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        const name = node.name.type === 'JSXIdentifier' ? node.name.name : null
        if (!name || !DEFAULT_PROPS.has(name) || isStaticValue(node.value)) return
        if (isForwarded(node.value.expression)) return
        for (let p = node.parent; p; p = p.parent) {
          if (p.type === 'JSXOpeningElement' && hasKey(p)) return
          if (p.type === 'JSXElement' && hasKey(p.openingElement)) return
          if (isFunctionNode(p) && p.parent?.type !== 'CallExpression') break
        }
        context.report({ node, messageId: 'missingKey', data: { name } })
      },
    }
  },
}

/**
 * 不受控的 `<CharCount>`（沒傳 `value`）要擋送出（CL-4 #846）。
 *
 * 拿掉原生 `maxLength` 之後，超過上限只有伺服器擋得到；React 19 的 `<form action>` 跑完一律重設表單，
 * 伺服器回「最多 N 字」時打的字已經清空。所以同一個元件裡外層的 `<form action>` 要有
 * `onSubmit={(e) => …blockOverLimit(e, …)…}`；或改成受控欄位、把 `value` 傳給 `CharCount`。
 */
export const charCountBlocksSubmit = {
  meta: {
    type: 'problem',
    docs: { description: '不受控的 CharCount 所在的 <form action> 要用 blockOverLimit 擋送出' },
    schema: [],
    messages: {
      noForm:
        '不受控的 `<CharCount>`（沒傳 value）要放在同一個元件的 `<form action>` 裡並用 `blockOverLimit` 擋送出，或改成受控欄位傳 `value`（CL-4）。',
      noBlock:
        '這個 `<form action>` 裡有不受控的 `<CharCount>`：`onSubmit` 要呼叫 `blockOverLimit`，否則超過上限被伺服器擋下時表單重設、字被清空（CL-4）。',
    },
  },
  create(context) {
    const source = context.sourceCode ?? context.getSourceCode()
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'CharCount' || jsxAttr(node, 'value')) return
        let form = null
        for (let p = node.parent?.parent; p; p = p.parent) {
          if (p.type === 'JSXElement' && p.openingElement.name.type === 'JSXIdentifier' && p.openingElement.name.name === 'form') {
            form = p.openingElement
            break
          }
          if (isFunctionNode(p) && p.parent?.type !== 'CallExpression') break
        }
        if (!form) {
          context.report({ node, messageId: 'noForm' })
          return
        }
        if (!jsxAttr(form, 'action')) return
        const onSubmit = jsxAttr(form, 'onSubmit')
        if (!onSubmit || !source.getText(onSubmit).includes('blockOverLimit')) context.report({ node, messageId: 'noBlock' })
      },
    }
  },
}

/**
 * `it.fails` 的主體只准一個 `expect`（⑤-12）。
 *
 * `it.fails` 是「這支該失敗」：主體有兩個 expect 時，其中一個先修好，另一個還沒修好的照樣讓它失敗，
 * 綠燈就不再代表「已知缺陷還在」。條件別名（`const check = issue ? it.fails : it`）也算。
 */
function isItFails(node) {
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'Identifier' &&
    (node.object.name === 'it' || node.object.name === 'test') &&
    node.property.type === 'Identifier' &&
    node.property.name === 'fails'
  )
}

function containsItFails(node) {
  if (!node) return false
  if (isItFails(node)) return true
  if (node.type === 'ConditionalExpression') return containsItFails(node.consequent) || containsItFails(node.alternate)
  if (node.type === 'LogicalExpression') return containsItFails(node.left) || containsItFails(node.right)
  return false
}

function countExpects(node) {
  let count = 0
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return
    if (n.type === 'CallExpression') {
      const c = n.callee
      if ((c.type === 'Identifier' && c.name === 'expect') || (c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.object.name === 'expect')) count++
    }
    for (const key of Object.keys(n)) {
      if (key === 'parent') continue
      const v = n[key]
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v.type === 'string') visit(v)
    }
  }
  visit(node)
  return count
}

export const itFailsSingleExpect = {
  meta: {
    type: 'problem',
    docs: { description: 'it.fails 的主體只准一個 expect' },
    schema: [],
    messages: {
      count:
        '`it.fails` 的主體只准一個 `expect`（這裡有 {{count}} 個）：一個先修好時，另一個還會讓它失敗，綠燈就不再代表缺陷還在。拆成每個斷言一支（⑤-12）。',
    },
  },
  create(context) {
    const aliases = new Set()
    return {
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && containsItFails(node.init)) aliases.add(node.id.name)
      },
      CallExpression(node) {
        const c = node.callee
        if (!isItFails(c) && !(c.type === 'Identifier' && aliases.has(c.name))) return
        const body = [...node.arguments].reverse().find(isFunctionNode)
        if (!body) return
        const count = countExpects(body.body)
        if (count !== 1) context.report({ node, messageId: 'count', data: { count } })
      },
    }
  },
}
