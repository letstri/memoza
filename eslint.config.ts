import antfu from '@antfu/eslint-config'

export default antfu({
  rules: {
    'ts/no-explicit-any': 'error',
    'no-console': 'warn',
  },
  ignores: [
    'dist',
  ],
})
