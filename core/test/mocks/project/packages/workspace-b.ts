export const pkg = {
  name: "@org/workspace-b",
  version: "2.3.1",
  description: "Mocked project used for unit testing",
  author: "Mario Arnautou",
  license: "MIT",
  dependencies: {
    "lodash.isequal": "4.5.0",
  },
  devDependencies: {
    "@org/workspace-a": "workspace:*",
    "typescript": "^4.2.4"
  }
};
