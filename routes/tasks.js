const express = require('express');
const router = express.Router();
const taskController = require('../controllers/taskController');

// /api/tasks
router.get('/', taskController.getTasks);
router.post('/', taskController.createTask);

// /api/tasks/:id
router.get('/:id', taskController.getTaskById);
router.put('/:id', taskController.updateTask);
router.delete('/:id', taskController.deleteTask);

module.exports = router;
