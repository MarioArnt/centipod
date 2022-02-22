(async () => {
  console.info('Launching...');
  setTimeout(() => {
    console.info('Something wrong happen');
    process.exit(1);
  }, 200);
})();
