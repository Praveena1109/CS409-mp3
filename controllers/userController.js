const User = require('../models/user');
const Task = require('../models/task');
const ErrorResponse = require('../utils/errorResponse');

function parseJSON(value, field) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new ErrorResponse(`Invalid JSON in '${field}'`, 400);
  }
}

/*  GET /users  */
exports.getUsers = async (req, res, next) => {
  try {
    const where = parseJSON(req.query.where, 'where');
    const sort = parseJSON(req.query.sort, 'sort');
    const select = parseJSON(req.query.select, 'select');
    const skip = parseInt(req.query.skip) || 0;
    const limit = req.query.limit ? parseInt(req.query.limit) : 0;

    if (req.query.count === 'true') {
      const count = await User.countDocuments(where || {});
      return res.status(200).json({ message: 'OK', data: count });
    }

    let query = User.find(where || {});
    if (sort) query = query.sort(sort);
    if (select) query = query.select(select);
    query = query.skip(skip);
    if (limit) query = query.limit(limit);

    const users = await query.exec();
    res.status(200).json({ message: 'OK', data: users });
  } catch (err) {
    next(
      err instanceof ErrorResponse
        ? err
        : new ErrorResponse('Failed to fetch users', 500)
    );
  }
};

/*  GET /users/:id  */
exports.getUserById = async (req, res, next) => {
  try {
    let query = User.findById(req.params.id);
    if (req.query.select) query = query.select(parseJSON(req.query.select, 'select'));
    const user = await query.exec();
    if (!user) return next(new ErrorResponse('User not found', 404));
    res.status(200).json({ message: 'OK', data: user });
  } catch {
    next(new ErrorResponse('Invalid user ID', 400));
  }
};

/*  POST /users  */
exports.createUser = async (req, res, next) => {
  try {
    let { name, email, pendingTasks } = req.body;
    if (!name || !email)
      return next(new ErrorResponse('Name and Email are required', 400));

    const existing = await User.findOne({
      email: new RegExp(`^${email}$`, 'i'),
    });
    if (existing)
      return next(new ErrorResponse('Email already exists', 400));

    pendingTasks = Array.isArray(pendingTasks)
      ? [...new Set(pendingTasks.map(String))]
      : [];

    const user = await User.create({
      name,
      email,
      pendingTasks: [],
      dateCreated: new Date(),
    });

    for (const taskId of pendingTasks) {
      const task = await Task.findById(taskId);
      if (!task)
        return next(new ErrorResponse(`Task ID ${taskId} does not exist`, 400));
      if (task.completed)
        return next(new ErrorResponse(`Cannot assign completed task (${taskId})`, 400));

      if (task.assignedUser && task.assignedUser !== user._id.toString()) {
        const oldUser = await User.findById(task.assignedUser);
        if (oldUser) {
          oldUser.pendingTasks = oldUser.pendingTasks.filter(
            id => id !== task._id.toString()
          );
          await oldUser.save();
        }
      }

      task.assignedUser = user._id.toString();
      task.assignedUserName = user.name;
      await task.save();

      if (!user.pendingTasks.includes(task._id.toString()))
        user.pendingTasks.push(task._id.toString());
    }

    await user.save();
    res.status(201).json({ message: 'User created', data: user });
  } catch {
    next(new ErrorResponse('Failed to create user', 500));
  }
};


/*  PUT /users/:id  */
exports.updateUser = async (req, res, next) => {
  try {
    let { name, email, pendingTasks } = req.body;
    if (!name || !email)
      return next(new ErrorResponse('Name and Email are required', 400));

    const user = await User.findById(req.params.id);
    if (!user) return next(new ErrorResponse('User not found', 404));

    const duplicate = await User.findOne({
      _id: { $ne: user._id },
      email: new RegExp(`^${email}$`, 'i'),
    });
    if (duplicate)
      return next(new ErrorResponse('Email already exists', 400));

    const oldTasks = await Task.find({
      assignedUser: user._id.toString(),
      completed: false,
    });
    for (const t of oldTasks) {
      t.assignedUser = '';
      t.assignedUserName = 'unassigned';
      await t.save();
    }

    user.name = name;
    user.email = email;

    pendingTasks = Array.isArray(pendingTasks)
      ? [...new Set(pendingTasks.map(String))]
      : [];
    user.pendingTasks = [];

    for (const taskId of pendingTasks) {
      const task = await Task.findById(taskId);
      if (!task)
        return next(new ErrorResponse(`Task ID ${taskId} does not exist`, 400));
      if (task.completed)
        return next(new ErrorResponse(`Cannot assign completed task (${taskId})`, 400));

      if (task.assignedUser && task.assignedUser !== user._id.toString()) {
        const oldUser = await User.findById(task.assignedUser);
        if (oldUser) {
          oldUser.pendingTasks = oldUser.pendingTasks.filter(
            id => id !== task._id.toString()
          );
          await oldUser.save();
        }
      }

      task.assignedUser = user._id.toString();
      task.assignedUserName = user.name;
      await task.save();

      if (!user.pendingTasks.includes(task._id.toString()))
        user.pendingTasks.push(task._id.toString());
    }

    await user.save();
    res.status(200).json({ message: 'User updated', data: user });
  } catch {
    next(new ErrorResponse('Failed to update user', 500));
  }
};


/*  DELETE /users/:id  */
exports.deleteUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return next(new ErrorResponse('User not found', 404));

    const tasks = await Task.find({ assignedUser: user._id.toString(), completed: false });
    for (const t of tasks) {
      t.assignedUser = '';
      t.assignedUserName = 'unassigned';
      await t.save();
    }

    await user.deleteOne();
    res.status(204).send();
  } catch {
    next(new ErrorResponse('Failed to delete user', 500));
  }
};
