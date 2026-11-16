// @hutch cli=0.29.0 cottontail=0.7.3
export default {
  scripts: {
    start: ["hutch", "electrobun", "dev"],
    build: ["hutch", "electrobun", "build", "--env=stable"],
  },
  electrobun: {
    version: "2.0.6",
  },
};
