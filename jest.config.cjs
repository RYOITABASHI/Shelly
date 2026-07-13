/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/__tests__/**/*.test.ts'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/$1',
      },
    },
    {
      displayName: 'component',
      preset: 'jest-expo',
      testMatch: ['<rootDir>/__tests__/**/*.test.tsx'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/$1',
      },
    },
  ],
};
