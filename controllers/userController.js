/**
 * User Controller
 * Implements CRUD operations for Users.
 *
 * Features Covered:
 * - Users API supports GET, POST, GET by ID, PUT, DELETE
 * - Responses include { message, data }
 * - Safe JSON query parsing for list endpoints
 * - Strict PUT (full replace) for users
 * - Two-way sync enforced between Users and Tasks
 * - Completed task rules: assign if unassigned; do not reassign away from existing owner; never add to pending
 * - Deleting a user unassigns ONLY their incomplete tasks
 */

const User = require('../models/user');
const Task = require('../models/task');
const ErrorResponse = require('../utils/errorResponse');

/** Build a single-line message with appended note parts if they exist. */
function withNote(base, noteParts) {
  const parts = (noteParts || []).filter(Boolean);
  if (!parts.length) return base;
  return `${base} ${parts.join(', ')}.`;
}

/** Add taskId to user's pendingTasks if not already present. */
function addPending(user, taskId) {
  const set = new Set(user.pendingTasks.map(String));
  if (!set.has(taskId)) user.pendingTasks.push(taskId);
}

/** Remove taskId from user's pendingTasks if present. */
function removePending(user, taskId) {
  user.pendingTasks = user.pendingTasks.filter(id => id !== taskId);
}

/**
 * Returns note parts in the order:
 * reassigned → unassigned → completedAssigned → completedNotReassigned → invalid
 */
function summarizeCounters(counters) {
  const parts = [];
  if (counters.reassigned) parts.push(`${counters.reassigned} task${counters.reassigned > 1 ? 's' : ''} reassigned`);
  if (counters.unassigned) parts.push(`${counters.unassigned} task${counters.unassigned > 1 ? 's' : ''} unassigned`);
  if (counters.completedAssigned) parts.push(`${counters.completedAssigned} completed task${counters.completedAssigned > 1 ? 's' : ''} assigned`);
  if (counters.completedNotReassigned) parts.push(`${counters.completedNotReassigned} completed task${counters.completedNotReassigned > 1 ? 's' : ''} not reassigned`);
  if (counters.invalid) parts.push(`${counters.invalid} invalid task ID${counters.invalid > 1 ? 's' : ''} ignored`);
  return parts;
}

/*  GET /users  */
/**
 * GET /users - Respond with list of users.
 * Supports ?where ?sort ?select ?skip ?limit ?count
 */
exports.getUsers = async (req, res, next) => {
  try {
    const parseJSON = (value, fieldName) => {
      if (!value) return undefined;
      try {
        return JSON.parse(value);
      } catch {
        throw new ErrorResponse(`Invalid JSON in '${fieldName}'`, 400);
      }
    };

    const where = parseJSON(req.query.where, 'where');
    const sort = parseJSON(req.query.sort, 'sort');
    const select = parseJSON(req.query.select, 'select');

    let query = User.find();

    if (where) query = query.find(where);
    if (sort) query = query.sort(sort);
    if (select) query = query.select(select);
    if (req.query.skip) query = query.skip(parseInt(req.query.skip));
    if (req.query.limit) query = query.limit(parseInt(req.query.limit));

    if (req.query.count === 'true') {
      const count = await User.countDocuments(where || {});
      return res.status(200).json({ message: 'OK', data: count });
    }

    const users = await query.exec();
    return res.status(200).json({ message: 'OK', data: users });
  } catch (err) {
    if (err instanceof ErrorResponse) return next(err);
    return next(new ErrorResponse('Failed to fetch users', 500));
  }
};

/*  GET /users/:id  */
/** GET /users/:id - Respond with user or 404. Supports ?select */
exports.getUserById = async (req, res, next) => {
  try {
    let query = User.findById(req.params.id);
    if (req.query.select) query = query.select(JSON.parse(req.query.select));

    const user = await query.exec();
    if (!user) return next(new ErrorResponse('User not found', 404));

    return res.status(200).json({ message: 'OK', data: user });
  } catch (err) {
    return next(new ErrorResponse('Invalid user ID', 400));
  }
};

/*  POST /users  */
/**
 * POST /users
 * - Validate name & email
 * - Unique email (case-insensitive)
 * - Allows pendingTasks; enforces two-way sync for completed tasks:
 *   • completed & unassigned → assign to user (not pending)
 *   • completed & assigned to someone else → do not reassign (note it)
 *   • completed & already this user → nothing extra
 */
exports.createUser = async (req, res, next) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) return next(new ErrorResponse('Name and Email are required', 400));

    const existing = await User.findOne({ email: new RegExp(`^${email}$`, 'i') });
    if (existing) return next(new ErrorResponse('Email already exists', 400));

    const user = new User({ name, email, pendingTasks: [] });
    await user.save();

    const incoming = Array.isArray(req.body.pendingTasks) ? req.body.pendingTasks.map(String) : [];
    const counters = { reassigned: 0, unassigned: 0, completedAssigned: 0, completedNotReassigned: 0, invalid: 0 };

    for (const taskId of incoming) {
      const task = await Task.findById(taskId);
      if (!task) { counters.invalid++; continue; }

      const current = task.assignedUser || '';
      const isSameUser = current === user._id.toString();

      if (task.completed) {
        if (!current) {
          task.assignedUser = user._id.toString();
          task.assignedUserName = user.name;
          await task.save();
          counters.completedAssigned++;
        } else if (!isSameUser) {
          counters.completedNotReassigned++;
        }
        continue; 
      }

      if (!current) {
        task.assignedUser = user._id.toString();
        task.assignedUserName = user.name;
        await task.save();
        addPending(user, task._id.toString());
      } else if (!isSameUser) {
        task.assignedUser = user._id.toString();
        task.assignedUserName = user.name;
        await task.save();
        addPending(user, task._id.toString());
        counters.reassigned++;
      } else {
        addPending(user, task._id.toString());
      }
    }

    await user.save();
    return res.status(201).json({
      message: withNote('User created successfully.', summarizeCounters(counters)),
      data: user
    });
  } catch (err) {
    return next(new ErrorResponse('Failed to create user', 500));
  }
};

/*  PUT /users/:id  */
/**
 * PUT /users/:id - strict replace (name, email required)
 * - If pendingTasks omitted → treat as []
 * - Two-way sync for completed tasks
 */
exports.updateUser = async (req, res, next) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) return next(new ErrorResponse('Name and Email are required', 400));

    const user = await User.findById(req.params.id);
    if (!user) return next(new ErrorResponse('User not found', 404));

    const duplicate = await User.findOne({
      _id: { $ne: user._id },
      email: new RegExp(`^${email}$`, 'i')
    });
    if (duplicate) return next(new ErrorResponse('Email already exists', 400));

    const oldPending = [...user.pendingTasks];
    const incoming = Array.isArray(req.body.pendingTasks) ? req.body.pendingTasks.map(String) : [];

    user.name = name;
    user.email = email;
    user.pendingTasks = []; 

    const counters = {
      reassigned: 0,
      unassigned: 0,
      completedAssigned: 0,
      completedNotReassigned: 0,
      invalid: 0
    };

    for (const oldTaskId of oldPending) {
      if (!incoming.includes(oldTaskId)) {
        const task = await Task.findById(oldTaskId);
        if (task && task.assignedUser === user._id.toString()) {
          task.assignedUser = '';
          task.assignedUserName = 'unassigned';
          await task.save();
          counters.unassigned++;
        }
      }
    }

    for (const taskId of incoming) {
      const task = await Task.findById(taskId);
      if (!task) { counters.invalid++; continue; }

      const current = task.assignedUser || '';
      const isSameUser = current === user._id.toString();

      if (task.completed) {
        if (!current) {
          task.assignedUser = user._id.toString();
          task.assignedUserName = user.name;
          await task.save();
          counters.completedAssigned++;
        } else if (!isSameUser) {
          counters.completedNotReassigned++;
        }
        continue;
      }

      if (!current) {
        task.assignedUser = user._id.toString();
        task.assignedUserName = user.name;
        await task.save();
        addPending(user, task._id.toString());
      } else if (!isSameUser) {
        task.assignedUser = user._id.toString();
        task.assignedUserName = user.name;
        await task.save();
        addPending(user, task._id.toString());
        counters.reassigned++;
      } else {
        addPending(user, task._id.toString());
      }
    }

    await user.save();

    return res.status(200).json({
      message: withNote('User updated.', summarizeCounters(counters)),
      data: user
    });
  } catch (err) {
    return next(new ErrorResponse('Invalid user ID', 400));
  }
};

/*  DELETE /users/:id  */
/**
 * DELETE /users/:id
 * - Unassign ONLY this user's incomplete tasks (pending)
 * - Return deleted user and count of tasks unassigned
 */
exports.deleteUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return next(new ErrorResponse('User not found', 404));

    const tasks = await Task.find({ assignedUser: user._id.toString(), completed: false });
    for (const task of tasks) {
      task.assignedUser = '';
      task.assignedUserName = 'unassigned';
      await task.save();
    }
    const unassignedCount = tasks.length;

    await user.deleteOne();

    const parts = [];
    if (unassignedCount) parts.push(`${unassignedCount} task${unassignedCount > 1 ? 's' : ''} unassigned`);
    return res.status(200).json({ message: withNote('User deleted.', parts), data: user });
  } catch (err) {
    return next(new ErrorResponse('User not found', 404));
  }
};
