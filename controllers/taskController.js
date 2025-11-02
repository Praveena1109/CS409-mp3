/**
 * Task Controller
 * Implements CRUD operations for Tasks.
 *
 * Features Covered:
 * - Tasks API supports GET, POST, GET by ID, PUT, DELETE
 * - Responses include { message, data }
 * - Safe JSON query parsing for list endpoints
 * - Strict PUT (full replace) for tasks
 * - Two-way sync with Users for assignment & pendingTasks
 * - Completed task rules: assign if unassigned; do not reassign away from existing owner; never add to pending
 */

const Task = require('../models/task');
const User = require('../models/user');
const ErrorResponse = require('../utils/errorResponse');

/** Build a single-line message with appended note parts if they exist. */
function withNote(base, noteParts) {
  const parts = (noteParts || []).filter(Boolean);
  if (!parts.length) return base;
  return `${base} ${parts.join(', ')}.`;
}

/** Add taskId to user's pendingTasks if not already present. */
function addPending(user, taskId) {
  const s = new Set(user.pendingTasks.map(String));
  if (!s.has(taskId)) user.pendingTasks.push(taskId);
}

/** Remove taskId from user's pendingTasks if present. */
function removePending(user, taskId) {
  user.pendingTasks = user.pendingTasks.filter(id => id !== taskId);
}

/** Load a user by id (string). If id is empty string -> return null. */
async function loadUserOrNull(userId) {
  if (!userId) return null;
  const user = await User.findById(userId);
  if (!user) throw new ErrorResponse('Invalid assigned user ID', 400);
  return user;
}

/**
 * Returns note parts in the order:
 * reassigned → unassigned → addedPending → removedPending → completedAssigned → completedNotReassigned
 */
function summarizeCounters(c) {
  const parts = [];
  if (c.reassigned) parts.push(`${c.reassigned} task${c.reassigned > 1 ? 's' : ''} reassigned`);
  if (c.unassigned) parts.push(`${c.unassigned} task${c.unassigned > 1 ? 's' : ''} unassigned`);
  if (c.addedPending) parts.push(`${c.addedPending} task${c.addedPending > 1 ? 's' : ''} added to pending`);
  if (c.removedPending) parts.push(`${c.removedPending} task${c.removedPending > 1 ? 's' : ''} removed from pending`);
  if (c.completedAssigned) parts.push(`${c.completedAssigned} completed task${c.completedAssigned > 1 ? 's' : ''} assigned`);
  if (c.completedNotReassigned) parts.push(`${c.completedNotReassigned} completed task${c.completedNotReassigned > 1 ? 's' : ''} not reassigned`);
  return parts;
}

/* GET /tasks */
/**
 * GET /tasks - Respond with list of tasks.
 * Supports ?where ?sort ?select ?skip ?limit ?count
 */
exports.getTasks = async (req, res, next) => {
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

    let query = Task.find();

    if (where) query = query.find(where);
    if (sort) query = query.sort(sort);
    if (select) query = query.select(select);
    if (req.query.skip) query = query.skip(parseInt(req.query.skip));
    query = req.query.limit ? query.limit(parseInt(req.query.limit)) : query.limit(100);

    if (req.query.count === 'true') {
      const count = await Task.countDocuments(where || {});
      return res.status(200).json({ message: 'OK', data: count });
    }

    const tasks = await query.exec();
    return res.status(200).json({ message: 'OK', data: tasks });
  } catch (err) {
    if (err instanceof ErrorResponse) return next(err);
    return next(new ErrorResponse('Failed to fetch tasks', 500));
  }
};

/* POST /tasks  */
/**
 * POST /tasks
 * - Validate name & deadline
 * - Compute assignedUserName automatically
 * - Add to pendingTasks only if assigned & not completed
 */
exports.createTask = async (req, res, next) => {
  try {
    const name = req.body?.name;
    const deadline = req.body?.deadline;
    if (!name || !deadline) {
      return next(new ErrorResponse('Name and Deadline are required', 400));
    }

    const description = typeof req.body.description === 'string' ? req.body.description : '';
    const completed = typeof req.body.completed === 'boolean' ? req.body.completed : false;

    const assignedUserId = typeof req.body.assignedUser === 'string' ? req.body.assignedUser : '';
    const assignedUser = await loadUserOrNull(assignedUserId); // may be null
    const assignedUserName = assignedUser ? assignedUser.name : 'unassigned';

    const task = new Task({
      name,
      description,
      deadline,
      completed,
      assignedUser: assignedUser ? assignedUser._id.toString() : '',
      assignedUserName
    });

    await task.save();

    if (assignedUser && !completed) {
      addPending(assignedUser, task._id.toString());
      await assignedUser.save();
    }

    return res.status(201).json({ message: 'Task created', data: task });
  } catch (err) {
    if (err instanceof ErrorResponse) return next(err);
    return next(new ErrorResponse('Failed to create task', 500));
  }
};

/*  GET /tasks/:id  */
/** GET /tasks/:id - Respond with task or 404. Supports ?select */
exports.getTaskById = async (req, res, next) => {
  try {
    let query = Task.findById(req.params.id);
    if (req.query.select) query = query.select(JSON.parse(req.query.select));

    const task = await query.exec();
    if (!task) return next(new ErrorResponse('Task not found', 404));

    return res.status(200).json({ message: 'OK', data: task });
  } catch (err) {
    return next(new ErrorResponse('Invalid task ID', 400));
  }
};

/*  PUT /tasks/:id  */
/**
 * PUT /tasks/:id - strict replace
 * - Update Users’ pendingTasks based on completion & assignment changes
 * - Completed rules:
 *   • If task is completed AND newUserId differs from a non-empty oldUserId → do NOT reassign (note it)
 *   • If task is completed AND oldUserId is empty AND newUserId provided → assign (not pending) (note it)
 */
exports.updateTask = async (req, res, next) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return next(new ErrorResponse('Task not found', 404));

    const name = req.body?.name;
    const deadline = req.body?.deadline;
    if (!name || !deadline) {
      return next(new ErrorResponse('Name and Deadline are required', 400));
    }

    const description = typeof req.body.description === 'string' ? req.body.description : '';
    const completed = typeof req.body.completed === 'boolean' ? req.body.completed : false;

    const assignedUserId = typeof req.body.assignedUser === 'string' ? req.body.assignedUser : '';
    let newUser = null;
    if (assignedUserId) newUser = await loadUserOrNull(assignedUserId);

    const oldUserId = task.assignedUser || '';
    const oldCompleted = !!task.completed;

    const newUserId = newUser ? newUser._id.toString() : '';
    const newAssignedUserName = newUser ? newUser.name : 'unassigned';

    const counters = { reassigned: 0, unassigned: 0, addedPending: 0, removedPending: 0, completedAssigned: 0, completedNotReassigned: 0 };

    if (completed) {
      if (oldUserId && newUserId && newUserId !== oldUserId) {
        counters.completedNotReassigned++;

        task.name = name;
        task.description = description;
        task.deadline = deadline;
        task.completed = completed;
        await task.save();

        const note = withNote('Task updated.', summarizeCounters(counters));
        return res.status(200).json({ message: note, data: task });
      }

      if (!oldUserId && newUserId) {
        task.name = name;
        task.description = description;
        task.deadline = deadline;
        task.completed = completed;
        task.assignedUser = newUserId;
        task.assignedUserName = newAssignedUserName;
        await task.save();
        counters.completedAssigned++;

        const note = withNote('Task updated.', summarizeCounters(counters));
        return res.status(200).json({ message: note, data: task });
      }
    }

    task.name = name;
    task.description = description;
    task.deadline = deadline;
    task.completed = completed;
    task.assignedUser = newUserId;
    task.assignedUserName = newAssignedUserName;

    if (oldUserId !== newUserId) {
      if (oldUserId) {
        const oldUser = await User.findById(oldUserId);
        if (oldUser) {
          removePending(oldUser, task._id.toString());
          await oldUser.save();
          counters.unassigned++;
        }
      }
      if (newUserId && !completed) {
        addPending(newUser, task._id.toString());
        await newUser.save();
        counters.reassigned++;
        counters.addedPending++;
      }
    } else {
      if (newUserId) {
        const sameUser = await User.findById(newUserId);
        if (sameUser) {
          if (!oldCompleted && completed) {
            removePending(sameUser, task._id.toString());
            await sameUser.save();
            counters.removedPending++;
          }
          if (oldCompleted && !completed) {
            addPending(sameUser, task._id.toString());
            await sameUser.save();
            counters.addedPending++;
          }
        }
      }
    }

    await task.save();

    const note = withNote('Task updated.', summarizeCounters(counters));
    return res.status(200).json({ message: note, data: task });
  } catch (err) {
    if (err instanceof ErrorResponse) return next(err);
    return next(new ErrorResponse('Invalid task ID', 400));
  }
};

/*  DELETE /tasks/:id  */
/**
 * DELETE /tasks/:id
 * - Remove the task from its assigned user's pendingTasks (if any)
 * - Delete the task
 */
exports.deleteTask = async (req, res, next) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return next(new ErrorResponse('Task not found', 404));

    if (task.assignedUser) {
      const user = await User.findById(task.assignedUser);
      if (user) {
        removePending(user, task._id.toString());
        await user.save();
      }
    }

    await task.deleteOne();

    return res.status(200).json({ message: 'Task deleted', data: task });
  } catch (err) {
    return next(new ErrorResponse('Invalid task ID', 400));
  }
};
