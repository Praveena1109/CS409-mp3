const Task = require('../models/task');
const User = require('../models/user');
const ErrorResponse = require('../utils/errorResponse');

function parseJSON(value, field) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new ErrorResponse(`Invalid JSON in '${field}'`, 400);
  }
}

/* GET /tasks */
exports.getTasks = async (req, res, next) => {
  try {
    const where = parseJSON(req.query.where, 'where');
    const sort = parseJSON(req.query.sort, 'sort');
    const select = parseJSON(req.query.select, 'select');
    const skip = parseInt(req.query.skip) || 0;
    const limit = parseInt(req.query.limit) || 100;

    let query = Task.find(where || {});
    if (sort) query = query.sort(sort);
    if (select) query = query.select(select);
    query = query.skip(skip).limit(limit);

    if (req.query.count === 'true') {
      const tasks = await query.exec();
      return res.status(200).json({ message: 'OK', data: tasks.length });
    }

    const tasks = await query.exec();
    res.status(200).json({ message: 'OK', data: tasks });
  } catch (err) {
    next(
      err instanceof ErrorResponse
        ? err
        : new ErrorResponse('Failed to fetch tasks', 500)
    );
  }
};

/* POST /tasks  */
exports.createTask = async (req, res, next) => {
  try {
    let { name, description, deadline, completed, assignedUser, assignedUserName } = req.body;
    if (!name || !deadline)
      return next(new ErrorResponse('Name and Deadline are required', 400));

    description = description || '';
    completed = completed || false;

    let finalAssignedUserName = 'unassigned';
    let assignedUserId = '';
    let user = null;

    if (assignedUser) {
      user = await User.findById(assignedUser);
      if (!user)
        return next(new ErrorResponse('Invalid assigned user ID', 400));

      if (assignedUserName && assignedUserName !== user.name)
        return next(new ErrorResponse(`assignedUserName does not match the user's actual name (${user.name})`, 400));

      assignedUserId = user._id.toString();
      finalAssignedUserName = user.name;
    }

    const task = await Task.create({
      name,
      description,
      deadline,
      completed,
      assignedUser: assignedUserId,
      assignedUserName: finalAssignedUserName,
      dateCreated: new Date(),
    });

    if (user && !completed) {
      if (!user.pendingTasks.includes(task._id.toString())) {
        user.pendingTasks.push(task._id.toString());
        await user.save();
      }
    }

    res.status(201).json({ message: 'Task created', data: task });
  } catch {
    next(new ErrorResponse('Failed to create task', 500));
  }
};

/*  GET /tasks/:id  */
exports.getTaskById = async (req, res, next) => {
  try {
    let query = Task.findById(req.params.id);
    if (req.query.select) query = query.select(parseJSON(req.query.select, 'select'));
    const task = await query.exec();
    if (!task) return next(new ErrorResponse('Task not found', 404));
    res.status(200).json({ message: 'OK', data: task });
  } catch {
    next(new ErrorResponse('Invalid task ID', 400));
  }
};

/*  PUT /tasks/:id  */
exports.updateTask = async (req, res, next) => {
  try {
    let { name, description, deadline, completed, assignedUser, assignedUserName } = req.body;
    if (!name || !deadline)
      return next(new ErrorResponse('Name and Deadline are required', 400));

    const task = await Task.findById(req.params.id);
    if (!task)
      return next(new ErrorResponse('Task not found', 404));

    if (task.assignedUser) {
      const oldUser = await User.findById(task.assignedUser);
      if (oldUser) {
        oldUser.pendingTasks = oldUser.pendingTasks.filter(id => id !== task._id.toString());
        await oldUser.save();
      }
    }

    description = description || '';
    completed = !!completed;

    let finalAssignedUserName = 'unassigned';
    let assignedUserId = '';
    let user = null;

    if (assignedUser) {
      user = await User.findById(assignedUser);
      if (!user)
        return next(new ErrorResponse('Invalid assigned user ID', 400));

      if (assignedUserName && assignedUserName !== user.name)
        return next(new ErrorResponse(`assignedUserName does not match the user's actual name (${user.name})`, 400));

      assignedUserId = user._id.toString();
      finalAssignedUserName = user.name;

      if (!completed) {
        if (!user.pendingTasks.includes(task._id.toString())) {
          user.pendingTasks.push(task._id.toString());
          await user.save();
        }
      }
    }

    task.name = name;
    task.description = description;
    task.deadline = deadline;
    task.completed = completed;
    task.assignedUser = assignedUserId;
    task.assignedUserName = finalAssignedUserName;

    await task.save();
    res.status(200).json({ message: 'Task updated', data: task });
  } catch {
    next(new ErrorResponse('Failed to update task', 500));
  }
};

/*  DELETE /tasks/:id  */
exports.deleteTask = async (req, res, next) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return next(new ErrorResponse('Task not found', 404));

    if (task.assignedUser) {
      const user = await User.findById(task.assignedUser);
      if (user) {
        user.pendingTasks = user.pendingTasks.filter(id => id !== task._id.toString());
        await user.save();
      }
    }

    await task.deleteOne();
    res.status(204).send();
  } catch {
    next(new ErrorResponse('Failed to delete task', 500));
  }
};
