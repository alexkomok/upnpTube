process.on('uncaughtException', e => console.log('⚠️ Skip:', e.message));
process.on('unhandledRejection', e => console.log('⚠️ Skip:', e.message));
