/*
 * Connect all of your endpoints together here.
 */
module.exports = function (app, router) {
    app.use('/api', require('./home.js')(router));
    // Users route
    app.use('/api/users', require('./users'));
    // Tasks route
    app.use('/api/tasks', require('./tasks'));
};
