const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Data paths
const DATA_DIR = path.join(__dirname, 'data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const ROUNDS_FILE = path.join(DATA_DIR, 'rounds.json');
const FUNDS_FILE = path.join(DATA_DIR, 'funds.json');

// Initialize data files
async function initData() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    
    // Initialize projects
    try {
      await fs.access(PROJECTS_FILE);
    } catch {
      await fs.writeFile(PROJECTS_FILE, JSON.stringify([]));
    }
    
    // Initialize rounds
    try {
      await fs.access(ROUNDS_FILE);
    } catch {
      await fs.writeFile(ROUNDS_FILE, JSON.stringify([]));
    }
    
    // Initialize funds
    try {
      await fs.access(FUNDS_FILE);
    } catch {
      await fs.writeFile(FUNDS_FILE, JSON.stringify([]));
    }
  } catch (error) {
    console.error('Error initializing data:', error);
  }
}

// Helper functions
async function readJSON(filePath) {
  const data = await fs.readFile(filePath, 'utf8');
  return JSON.parse(data);
}

async function writeJSON(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

// Calculate quadratic funding weight for a project
function calculateQuadraticWeight(contributions) {
  const sqrtSum = contributions.reduce((sum, contrib) => {
    return sum + Math.sqrt(contrib.amount);
  }, 0);
  return Math.pow(sqrtSum, 2);
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ROUNDS ENDPOINTS

// Create a funding round
app.post('/api/rounds', async (req, res) => {
  try {
    const { name, startDate, endDate, totalPool, fundingBudgetPerAgent } = req.body;
    
    if (!name || !startDate || !endDate || !totalPool) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const rounds = await readJSON(ROUNDS_FILE);
    const newRound = {
      id: Date.now().toString(),
      name,
      startDate,
      endDate,
      totalPool,
      fundingBudgetPerAgent: fundingBudgetPerAgent || 100,
      status: new Date() < new Date(startDate) ? 'upcoming' : 
              new Date() > new Date(endDate) ? 'completed' : 'active',
      createdAt: new Date().toISOString()
    };
    
    rounds.push(newRound);
    await writeJSON(ROUNDS_FILE, rounds);
    
    res.status(201).json(newRound);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List all rounds
app.get('/api/rounds', async (req, res) => {
  try {
    const rounds = await readJSON(ROUNDS_FILE);
    
    // Update status based on current date
    const now = new Date();
    rounds.forEach(round => {
      if (now < new Date(round.startDate)) {
        round.status = 'upcoming';
      } else if (now > new Date(round.endDate)) {
        round.status = 'completed';
      } else {
        round.status = 'active';
      }
    });
    
    await writeJSON(ROUNDS_FILE, rounds);
    res.json(rounds);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get round details with projects and allocations
app.get('/api/rounds/:id', async (req, res) => {
  try {
    const rounds = await readJSON(ROUNDS_FILE);
    const round = rounds.find(r => r.id === req.params.id);
    
    if (!round) {
      return res.status(404).json({ error: 'Round not found' });
    }
    
    // Get projects for this round
    const projects = await readJSON(PROJECTS_FILE);
    const roundProjects = projects.filter(p => p.roundId === round.id);
    
    // Get funding data
    const funds = await readJSON(FUNDS_FILE);
    const roundFunds = funds.filter(f => f.roundId === round.id);
    
    // Calculate quadratic weights for each project
    const projectsWithWeights = roundProjects.map(project => {
      const projectFunds = roundFunds.filter(f => f.projectId === project.id);
      const totalContributions = projectFunds.reduce((sum, f) => sum + f.amount, 0);
      const quadraticWeight = calculateQuadraticWeight(projectFunds);
      
      return {
        ...project,
        totalContributions,
        quadraticWeight,
        contributorsCount: projectFunds.length,
        contributions: projectFunds
      };
    });
    
    // Calculate matching from pool
    const totalWeight = projectsWithWeights.reduce((sum, p) => sum + p.quadraticWeight, 0);
    projectsWithWeights.forEach(project => {
      project.matchingAmount = totalWeight > 0 
        ? (project.quadraticWeight / totalWeight) * round.totalPool 
        : 0;
      project.totalFunding = project.totalContributions + project.matchingAmount;
    });
    
    res.json({
      ...round,
      projects: projectsWithWeights.sort((a, b) => b.totalFunding - a.totalFunding)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PROJECTS ENDPOINTS

// Nominate a project
app.post('/api/projects', async (req, res) => {
  try {
    const { title, description, repoUrl, category, nominatorAgent, roundId } = req.body;
    
    if (!title || !description || !nominatorAgent || !roundId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Verify round exists
    const rounds = await readJSON(ROUNDS_FILE);
    const round = rounds.find(r => r.id === roundId);
    if (!round) {
      return res.status(400).json({ error: 'Round not found' });
    }
    
    const projects = await readJSON(PROJECTS_FILE);
    const newProject = {
      id: Date.now().toString(),
      title,
      description,
      repoUrl: repoUrl || '',
      category: category || 'general',
      nominatorAgent,
      roundId,
      createdAt: new Date().toISOString()
    };
    
    projects.push(newProject);
    await writeJSON(PROJECTS_FILE, projects);
    
    res.status(201).json(newProject);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Browse all projects
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await readJSON(PROJECTS_FILE);
    const funds = await readJSON(FUNDS_FILE);
    
    // Add funding info to each project
    const projectsWithFunding = projects.map(project => {
      const projectFunds = funds.filter(f => f.projectId === project.id);
      const totalContributions = projectFunds.reduce((sum, f) => sum + f.amount, 0);
      const quadraticWeight = calculateQuadraticWeight(projectFunds);
      
      return {
        ...project,
        totalContributions,
        quadraticWeight,
        contributorsCount: projectFunds.length
      };
    });
    
    res.json(projectsWithFunding);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get project details
app.get('/api/projects/:id', async (req, res) => {
  try {
    const projects = await readJSON(PROJECTS_FILE);
    const project = projects.find(p => p.id === req.params.id);
    
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    const funds = await readJSON(FUNDS_FILE);
    const projectFunds = funds.filter(f => f.projectId === project.id);
    
    const totalContributions = projectFunds.reduce((sum, f) => sum + f.amount, 0);
    const quadraticWeight = calculateQuadraticWeight(projectFunds);
    
    res.json({
      ...project,
      totalContributions,
      quadraticWeight,
      contributorsCount: projectFunds.length,
      contributions: projectFunds
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fund a project
app.post('/api/projects/:id/fund', async (req, res) => {
  try {
    const { agentName, amount } = req.body;
    const projectId = req.params.id;
    
    if (!agentName || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid funding request' });
    }
    
    // Verify project exists
    const projects = await readJSON(PROJECTS_FILE);
    const project = projects.find(p => p.id === projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    // Get round to check budget
    const rounds = await readJSON(ROUNDS_FILE);
    const round = rounds.find(r => r.id === project.roundId);
    if (!round) {
      return res.status(400).json({ error: 'Round not found' });
    }
    
    // Check if round is active
    const now = new Date();
    if (now < new Date(round.startDate) || now > new Date(round.endDate)) {
      return res.status(400).json({ error: 'Round is not active' });
    }
    
    // Check agent's total spending in this round
    const funds = await readJSON(FUNDS_FILE);
    const agentSpending = funds
      .filter(f => f.roundId === round.id && f.agentName === agentName)
      .reduce((sum, f) => sum + f.amount, 0);
    
    if (agentSpending + amount > round.fundingBudgetPerAgent) {
      return res.status(400).json({ 
        error: `Budget exceeded. You have ${round.fundingBudgetPerAgent - agentSpending} points remaining.` 
      });
    }
    
    // Create funding record
    const newFund = {
      id: Date.now().toString(),
      projectId,
      roundId: round.id,
      agentName,
      amount,
      createdAt: new Date().toISOString()
    };
    
    funds.push(newFund);
    await writeJSON(FUNDS_FILE, funds);
    
    res.status(201).json(newFund);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
initData().then(() => {
  app.listen(PORT, () => {
    console.log(`MoltFund running on port ${PORT}`);
  });
});
