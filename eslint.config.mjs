// eslint.config.mjs
//
// ESLint 扁平配置（ESLint 9+）。用 .mjs 是因为根 package.json 是 commonjs。
//
// 这个配置不只查语法错误，还刻意开启了**复杂度类规则**：
// complexity / max-depth / max-params / max-lines-per-function。
// 这些指标是"代码是不是在变成屎山"最直接的可量化信号——
// 一个函数嵌套 6 层、200 行、8 个参数，基本就没人能安全改它了。
//
// 复杂度类规则设为 warn 而不是 error：它们要暴露趋势，不是卡住提交。
// 真正该挡住的（未定义变量、重复 key、不可达代码）保持 error。

import js from '@eslint/js'
import globals from 'globals'

/** 两个代码库共用的复杂度预算。数值不是随便定的，后面报告里会对照。 */
const COMPLEXITY_BUDGET = {
  complexity: ['warn', 12],
  'max-depth': ['warn', 4],
  'max-params': ['warn', 5],
  'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
  'max-nested-callbacks': ['warn', 3],
  'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
}

const SHARED_RULES = {
  // ---- 真问题，保持 error ----
  'no-undef': 'error',
  'no-unused-vars': ['error', { argsIgnorePattern: '^_|^next$|^req$|^res$', varsIgnorePattern: '^_' }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-constant-binary-expression': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-promise-executor-return': 'error',
  'no-template-curly-in-string': 'error',
  'array-callback-return': 'error',
  'no-throw-literal': 'error',
  'require-atomic-updates': 'error',
  'valid-typeof': 'error',
  'use-isnan': 'error',

  // ---- 风格一致性：一个项目里混着写才是维护灾难 ----
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
  'prefer-const': 'error',
  'no-shadow': 'warn',
  'no-else-return': 'warn',
  'no-lonely-if': 'warn',
  'no-useless-return': 'warn',
  'no-useless-concat': 'warn',
  'no-useless-rename': 'warn',
  'object-shorthand': 'warn',
  'prefer-template': 'warn',
  'no-duplicate-imports': 'error',
  'no-return-await': 'warn',
  'require-await': 'warn',
  'no-await-in-loop': 'off',
  'consistent-return': 'off',
  'no-console': 'off',
  'no-empty': ['error', { allowEmptyCatch: true }],

  ...COMPLEXITY_BUDGET,
}

export default [
  {
    ignores: [
      '**/node_modules/**',
      'dist/**',
      'storage/**',
      'ui-check-shots/**',
      '.acl-recovery/**',
    ],
  },

  // ESLint 官方推荐规则集。先铺一层底线，下面的分块再按场景覆盖。
  js.configs.recommended,

  // ---------------------------------------------------------- 后端（Node CJS）
  {
    files: ['backend/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: SHARED_RULES,
  },

  // eslint.config.mjs 本身是 ESM
  {
    files: ['eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: SHARED_RULES,
  },

  // ---------------------------------------------------------- 前端（浏览器 ESM）
  {
    files: ['frontend/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Vite 注入的
        __DEV__: 'readonly',
      },
    },
    rules: {
      ...SHARED_RULES,
      // 前端里 console 只用于真正的调试输出，留着方便排查
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // ---------------------------------------------------------- Vite 配置
  {
    files: ['frontend/vite.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        // Vite 在打包配置文件时会为 ESM 输出注入 __dirname 垫片，
        // 它指向配置文件所在目录（用 import.meta.dirname 反而会指向临时目录）。
        // 所以这里是合法用法，ESLint 只是不知道这个垫片存在。
        __dirname: 'readonly',
      },
    },
    rules: SHARED_RULES,
  },
]
