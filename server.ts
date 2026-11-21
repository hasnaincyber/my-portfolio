import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { desc, eq } from 'drizzle-orm';
import { db } from './src/db/index.ts';
import {
  contactSubmissions,
  experienceEducation,
  graphicDesigns,
  kuConnectContent,
  marketingCaseStudies,
  profileSettings,
  projects,
  skills,
} from './src/db/schema.ts';
import {
  createContactSubmission,
  ensureSeeded,
  getPortfolioBundle,
  getProjectBySlug,
} from './src/db/repository.ts';
import { AuthRequest, requireAdmin, requireAuth } from './src/middleware/auth.ts';

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const uploadsDir = path.resolve(process.cwd(), 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

function isSafeString(val: unknown, maxLen = 5000): val is string {
  return typeof val === 'string' && val.trim().length > 0 && val.length <= maxLen;
}

function isOptionalSafeString(val: unknown, maxLen = 5000): val is string {
  return typeof val === 'string' && val.length <= maxLen;
}

function isValidUrlOrLocalPath(val: string): boolean {
  if (!val) return true;
  if (val.startsWith('/uploads/') || val.startsWith('/src/assets/') || val.startsWith('/assets/')) return true;
  try {
    const parsed = new URL(val);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const ALLOWED_UPLOAD_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
};

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));

  app.use('/uploads', (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  }, express.static(uploadsDir));

  // Public Portfolio API
  app.get('/api/portfolio', async (_req, res) => {
    try {
      const bundle = await getPortfolioBundle();
      res.json(bundle);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Unable to load portfolio data.' });
    }
  });

  app.get('/api/projects/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').trim();
    if (!slug || slug.length > 100) {
      return res.status(400).json({ error: 'Invalid project identifier.' });
    }
    try {
      const project = await getProjectBySlug(slug);
      if (!project) {
        return res.status(404).json({ error: 'Project not found.' });
      }
      res.json(project);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Unable to load project.' });
    }
  });

  app.post('/api/contact', async (req, res) => {
    const { name, email, subject, serviceInterest, message } = req.body ?? {};
    if (
      !isSafeString(name, 120) ||
      !isSafeString(email, 160) ||
      !isSafeString(subject, 200) ||
      !isSafeString(serviceInterest, 120) ||
      !isSafeString(message, 4000)
    ) {
      return res.status(400).json({ error: 'Please complete all required fields cleanly.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    try {
      const submission = await createContactSubmission({
        name: name.trim(),
        email: email.trim(),
        subject: subject.trim(),
        serviceInterest: serviceInterest.trim(),
        message: message.trim(),
      });
      res.status(201).json({ success: true, id: submission.id });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Unable to send message.' });
    }
  });

  // Auth status endpoint
  app.get('/api/auth/me', requireAuth, async (req: AuthRequest, res) => {
    res.json({
      uid: req.user?.uid,
      email: req.user?.email,
      role: req.userRole,
      isAdmin: req.userRole === 'admin',
    });
  });

  // Admin Upload Endpoint (images & certificates/CV PDFs)
  app.post('/api/admin/upload', requireAdmin, async (req: AuthRequest, res) => {
    const { dataUrl, fileName } = req.body ?? {};
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      return res.status(400).json({ error: 'Invalid upload payload.' });
    }
    const match = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/.exec(dataUrl);
    if (!match) {
      return res.status(400).json({ error: 'Malformed file data.' });
    }
    const mimeType = match[1].toLowerCase();
    const ext = ALLOWED_UPLOAD_TYPES[mimeType];
    if (!ext) {
      return res.status(400).json({ error: 'Only PNG, JPG, WEBP, GIF, and PDF files are permitted.' });
    }
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length === 0 || buffer.length > 6 * 1024 * 1024) {
      return res.status(400).json({ error: 'File must be under 6 MB.' });
    }

    const baseName = slugify(String(fileName || 'asset').replace(/\.[^/.]+$/, '')) || 'asset';
    const uniqueName = `${baseName}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    const targetPath = path.resolve(uploadsDir, uniqueName);
    if (!targetPath.startsWith(uploadsDir + path.sep)) {
      return res.status(400).json({ error: 'Invalid destination path.' });
    }

    await fs.promises.writeFile(targetPath, buffer);
    res.status(201).json({ url: `/uploads/${uniqueName}` });
  });

  // Admin Profile Management
  app.put('/api/admin/profile', requireAdmin, async (req, res) => {
    try {
      await ensureSeeded();
      const body = req.body ?? {};
      if (
        !isSafeString(body.fullName, 140) ||
        !isSafeString(body.headline, 160) ||
        !isSafeString(body.introBio, 1200) ||
        !isSafeString(body.aboutBio, 3000) ||
        !isSafeString(body.education, 300) ||
        !isSafeString(body.email, 160) ||
        !isSafeString(body.whatsapp, 80)
      ) {
        return res.status(400).json({ error: 'Required profile fields cannot be empty.' });
      }
      const urlsToCheck = [
        body.linkedinUrl || '',
        body.instagramUrl || '',
        body.githubUrl || '',
        body.cvUrl || '',
        body.portraitUrl || '',
      ];
      if (!urlsToCheck.every((u) => typeof u === 'string' && isValidUrlOrLocalPath(u))) {
        return res.status(400).json({ error: 'One or more profile URLs are invalid.' });
      }

      const existing = await db.select().from(profileSettings).limit(1);
      const interests = Array.isArray(body.interests)
        ? body.interests.map((x: unknown) => String(x).trim()).filter(Boolean)
        : [];

      const payload = {
        fullName: body.fullName.trim(),
        headline: body.headline.trim(),
        introBio: body.introBio.trim(),
        aboutBio: body.aboutBio.trim(),
        education: body.education.trim(),
        interests,
        email: body.email.trim(),
        whatsapp: body.whatsapp.trim(),
        linkedinUrl: String(body.linkedinUrl || '').trim(),
        instagramUrl: String(body.instagramUrl || '').trim(),
        githubUrl: String(body.githubUrl || '').trim(),
        cvUrl: String(body.cvUrl || '').trim(),
        portraitUrl: String(body.portraitUrl || '').trim(),
        updatedAt: new Date(),
      };

      const updated = existing.length
        ? await db
            .update(profileSettings)
            .set(payload)
            .where(eq(profileSettings.id, existing[0].id))
            .returning()
        : await db.insert(profileSettings).values(payload).returning();

      res.json(updated[0]);
    } catch (error: any) {
      console.error('Update profile error:', error);
      res.status(500).json({ error: 'Failed to update profile.' });
    }
  });

  // Admin KU Connect Management
  app.put('/api/admin/ku-connect', requireAdmin, async (req, res) => {
    try {
      await ensureSeeded();
      const body = req.body ?? {};
      if (
        !isSafeString(body.projectName, 120) ||
        !isSafeString(body.projectType, 200) ||
        !isSafeString(body.liveUrl, 300) ||
        !isSafeString(body.overview, 3000) ||
        !isSafeString(body.problemStatement, 3000) ||
        !isSafeString(body.vision, 3000)
      ) {
        return res.status(400).json({ error: 'Core KU Connect fields are required.' });
      }
      if (!isValidUrlOrLocalPath(body.liveUrl) || !isValidUrlOrLocalPath(body.coverImage || '')) {
        return res.status(400).json({ error: 'Invalid URL provided for KU Connect.' });
      }

      const existing = await db.select().from(kuConnectContent).limit(1);
      const screenshots = Array.isArray(body.screenshots)
        ? body.screenshots.map((s: unknown) => String(s).trim()).filter(isValidUrlOrLocalPath)
        : [];
      const targetUsers = Array.isArray(body.targetUsers)
        ? body.targetUsers.map((s: unknown) => String(s).trim()).filter(Boolean)
        : [];
      const modules = Array.isArray(body.modules) ? body.modules : [];

      const payload = {
        projectName: body.projectName.trim(),
        projectType: body.projectType.trim(),
        liveUrl: body.liveUrl.trim(),
        overview: body.overview.trim(),
        problemStatement: body.problemStatement.trim(),
        vision: body.vision.trim(),
        targetUsers,
        designProcess: String(body.designProcess || '').trim(),
        techApproach: String(body.techApproach || '').trim(),
        challengesLearnings: String(body.challengesLearnings || '').trim(),
        futureRoadmap: String(body.futureRoadmap || '').trim(),
        coverImage: String(body.coverImage || '').trim(),
        screenshots,
        modules,
        updatedAt: new Date(),
      };

      const updated = existing.length
        ? await db
            .update(kuConnectContent)
            .set(payload)
            .where(eq(kuConnectContent.id, existing[0].id))
            .returning()
        : await db.insert(kuConnectContent).values(payload).returning();

      res.json(updated[0]);
    } catch (error: any) {
      console.error('Update KU Connect error:', error);
      res.status(500).json({ error: 'Failed to update KU Connect content.' });
    }
  });

  // Admin Projects CRUD
  app.post('/api/admin/projects', requireAdmin, async (req, res) => {
    try {
      const body = req.body ?? {};
      if (
        !isSafeString(body.title, 140) ||
        !isSafeString(body.category, 100) ||
        !isSafeString(body.summary, 600) ||
        !isSafeString(body.liveUrl, 300)
      ) {
        return res.status(400).json({ error: 'Title, category, summary, and live URL are required.' });
      }
      if (
        !isValidUrlOrLocalPath(body.liveUrl) ||
        !isValidUrlOrLocalPath(body.githubUrl || '') ||
        !isValidUrlOrLocalPath(body.coverImage || '')
      ) {
        return res.status(400).json({ error: 'Invalid project URL or image path.' });
      }
      const slug = slugify(body.slug || body.title);
      const technologies = Array.isArray(body.technologies)
        ? body.technologies.map((t: unknown) => String(t).trim()).filter(Boolean)
        : [];
      const screenshots = Array.isArray(body.screenshots)
        ? body.screenshots.map((s: unknown) => String(s).trim()).filter(isValidUrlOrLocalPath)
        : [];

      const created = await db
        .insert(projects)
        .values({
          slug: `${slug}-${crypto.randomBytes(2).toString('hex')}`,
          title: body.title.trim(),
          category: body.category.trim(),
          projectType: String(body.projectType || body.category).trim(),
          collaborationType: String(body.collaborationType || 'Individual Work').trim(),
          summary: body.summary.trim(),
          description: String(body.description || body.summary).trim(),
          technologies,
          liveUrl: body.liveUrl.trim(),
          githubUrl: String(body.githubUrl || '').trim(),
          coverImage: String(body.coverImage || '/src/assets/images/web_hospitality_showcase_1795242360766.jpg').trim(),
          screenshots,
          isFlagship: Boolean(body.isFlagship),
          isFeatured: body.isFeatured !== false,
          sortOrder: Number(body.sortOrder || 10),
        })
        .returning();

      res.status(201).json(created[0]);
    } catch (error: any) {
      console.error('Create project error:', error);
      res.status(500).json({ error: 'Failed to create project.' });
    }
  });

  app.put('/api/admin/projects/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid project ID.' });
    }
    try {
      const body = req.body ?? {};
      if (
        !isSafeString(body.title, 140) ||
        !isSafeString(body.category, 100) ||
        !isSafeString(body.summary, 600) ||
        !isSafeString(body.liveUrl, 300)
      ) {
        return res.status(400).json({ error: 'Title, category, summary, and live URL are required.' });
      }
      if (
        !isValidUrlOrLocalPath(body.liveUrl) ||
        !isValidUrlOrLocalPath(body.githubUrl || '') ||
        !isValidUrlOrLocalPath(body.coverImage || '')
      ) {
        return res.status(400).json({ error: 'Invalid project URL or image path.' });
      }
      const technologies = Array.isArray(body.technologies)
        ? body.technologies.map((t: unknown) => String(t).trim()).filter(Boolean)
        : [];
      const screenshots = Array.isArray(body.screenshots)
        ? body.screenshots.map((s: unknown) => String(s).trim()).filter(isValidUrlOrLocalPath)
        : [];

      const updated = await db
        .update(projects)
        .set({
          title: body.title.trim(),
          category: body.category.trim(),
          projectType: String(body.projectType || body.category).trim(),
          collaborationType: String(body.collaborationType || 'Individual Work').trim(),
          summary: body.summary.trim(),
          description: String(body.description || body.summary).trim(),
          technologies,
          liveUrl: body.liveUrl.trim(),
          githubUrl: String(body.githubUrl || '').trim(),
          coverImage: String(body.coverImage || '').trim(),
          screenshots,
          isFlagship: Boolean(body.isFlagship),
          isFeatured: body.isFeatured !== false,
          sortOrder: Number(body.sortOrder || 0),
          updatedAt: new Date(),
        })
        .where(eq(projects.id, id))
        .returning();

      if (!updated.length) return res.status(404).json({ error: 'Project not found.' });
      res.json(updated[0]);
    } catch (error: any) {
      console.error('Update project error:', error);
      res.status(500).json({ error: 'Failed to update project.' });
    }
  });

  app.delete('/api/admin/projects/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid project ID.' });
    }
    try {
      await db.delete(projects).where(eq(projects.id, id));
      res.json({ deleted: true });
    } catch (error: any) {
      console.error('Delete project error:', error);
      res.status(500).json({ error: 'Failed to delete project.' });
    }
  });

  // Admin Graphic Designs CRUD
  app.post('/api/admin/designs', requireAdmin, async (req, res) => {
    try {
      const { title, category, description, imageUrl, aspectRatio } = req.body ?? {};
      if (
        !isSafeString(title, 140) ||
        !isSafeString(category, 100) ||
        !isSafeString(description, 1000) ||
        !isSafeString(imageUrl, 300) ||
        !isValidUrlOrLocalPath(imageUrl)
      ) {
        return res.status(400).json({ error: 'Valid title, category, description, and image are required.' });
      }
      const created = await db
        .insert(graphicDesigns)
        .values({
          title: title.trim(),
          category: category.trim(),
          description: description.trim(),
          imageUrl: imageUrl.trim(),
          aspectRatio: String(aspectRatio || '3/4').trim(),
        })
        .returning();
      res.status(201).json(created[0]);
    } catch (error: any) {
      console.error('Create design error:', error);
      res.status(500).json({ error: 'Failed to save graphic design.' });
    }
  });

  app.put('/api/admin/designs/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID.' });
    try {
      const { title, category, description, imageUrl, aspectRatio } = req.body ?? {};
      if (!isSafeString(title, 140) || !isSafeString(category, 100) || !isSafeString(description, 1000)) {
        return res.status(400).json({ error: 'Title, category, and description are required.' });
      }
      if (imageUrl && !isValidUrlOrLocalPath(imageUrl)) {
        return res.status(400).json({ error: 'Invalid image URL.' });
      }
      const updated = await db
        .update(graphicDesigns)
        .set({
          title: title.trim(),
          category: category.trim(),
          description: description.trim(),
          ...(imageUrl ? { imageUrl: imageUrl.trim() } : {}),
          aspectRatio: String(aspectRatio || '3/4').trim(),
        })
        .where(eq(graphicDesigns.id, id))
        .returning();
      if (!updated.length) return res.status(404).json({ error: 'Design not found.' });
      res.json(updated[0]);
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to update design.' });
    }
  });

  app.delete('/api/admin/designs/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID.' });
    try {
      await db.delete(graphicDesigns).where(eq(graphicDesigns.id, id));
      res.json({ deleted: true });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to delete design.' });
    }
  });

  // Admin Marketing Case Studies CRUD
  app.post('/api/admin/marketing', requireAdmin, async (req, res) => {
    try {
      const body = req.body ?? {};
      if (
        !isSafeString(body.title, 160) ||
        !isSafeString(body.channel, 80) ||
        !isSafeString(body.overview, 2000) ||
        !isSafeString(body.objectives, 1200) ||
        !isSafeString(body.targetAudience, 800) ||
        !isSafeString(body.strategy, 2000)
      ) {
        return res.status(400).json({ error: 'Please provide all required case study fields.' });
      }
      const creativeImage = String(body.creativeImage || '/src/assets/images/marketing_campaign_visual_1795242361133.jpg').trim();
      if (!isValidUrlOrLocalPath(creativeImage)) {
        return res.status(400).json({ error: 'Invalid creative image URL.' });
      }
      const toolsUsed = Array.isArray(body.toolsUsed)
        ? body.toolsUsed.map((t: unknown) => String(t).trim()).filter(Boolean)
        : [];

      const created = await db
        .insert(marketingCaseStudies)
        .values({
          title: body.title.trim(),
          channel: body.channel.trim(),
          overview: body.overview.trim(),
          objectives: body.objectives.trim(),
          targetAudience: body.targetAudience.trim(),
          strategy: body.strategy.trim(),
          toolsUsed,
          creativeImage,
          results: isOptionalSafeString(body.results, 1500) ? body.results.trim() : '',
        })
        .returning();
      res.status(201).json(created[0]);
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to save marketing case study.' });
    }
  });

  app.put('/api/admin/marketing/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID.' });
    try {
      const body = req.body ?? {};
      if (!isSafeString(body.title, 160) || !isSafeString(body.channel, 80) || !isSafeString(body.overview, 2000)) {
        return res.status(400).json({ error: 'Title, channel, and overview are required.' });
      }
      if (body.creativeImage && !isValidUrlOrLocalPath(body.creativeImage)) {
        return res.status(400).json({ error: 'Invalid creative image URL.' });
      }
      const toolsUsed = Array.isArray(body.toolsUsed)
        ? body.toolsUsed.map((t: unknown) => String(t).trim()).filter(Boolean)
        : [];
      const updated = await db
        .update(marketingCaseStudies)
        .set({
          title: body.title.trim(),
          channel: body.channel.trim(),
          overview: body.overview.trim(),
          objectives: String(body.objectives || '').trim(),
          targetAudience: String(body.targetAudience || '').trim(),
          strategy: String(body.strategy || '').trim(),
          toolsUsed,
          ...(body.creativeImage ? { creativeImage: body.creativeImage.trim() } : {}),
          results: String(body.results || '').trim(),
        })
        .where(eq(marketingCaseStudies.id, id))
        .returning();
      if (!updated.length) return res.status(404).json({ error: 'Case study not found.' });
      res.json(updated[0]);
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to update case study.' });
    }
  });

  app.delete('/api/admin/marketing/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID.' });
    try {
      await db.delete(marketingCaseStudies).where(eq(marketingCaseStudies.id, id));
      res.json({ deleted: true });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to delete case study.' });
    }
  });

  // Admin Experience & Education CRUD
  app.post('/api/admin/experience', requireAdmin, async (req, res) => {
    try {
      const body = req.body ?? {};
      if (
        !isSafeString(body.entryType, 40) ||
        !isSafeString(body.organization, 160) ||
        !isSafeString(body.roleOrDegree, 160) ||
        !isSafeString(body.period, 80) ||
        !isSafeString(body.description, 1200)
      ) {
        return res.status(400).json({ error: 'All timeline fields are required.' });
      }
      if (body.certificateUrl && !isValidUrlOrLocalPath(body.certificateUrl)) {
        return res.status(400).json({ error: 'Invalid certificate URL.' });
      }
      const created = await db
        .insert(experienceEducation)
        .values({
          entryType: body.entryType.trim(),
          organization: body.organization.trim(),
          roleOrDegree: body.roleOrDegree.trim(),
          period: body.period.trim(),
          description: body.description.trim(),
          certificateUrl: String(body.certificateUrl || '').trim(),
          sortOrder: Number(body.sortOrder || 10),
        })
        .returning();
      res.status(201).json(created[0]);
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to add timeline entry.' });
    }
  });

  app.put('/api/admin/experience/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID.' });
    try {
      const body = req.body ?? {};
      if (body.certificateUrl && !isValidUrlOrLocalPath(body.certificateUrl)) {
        return res.status(400).json({ error: 'Invalid certificate URL.' });
      }
      const updated = await db
        .update(experienceEducation)
        .set({
          entryType: String(body.entryType || 'Experience').trim(),
          organization: String(body.organization || '').trim(),
          roleOrDegree: String(body.roleOrDegree || '').trim(),
          period: String(body.period || '').trim(),
          description: String(body.description || '').trim(),
          certificateUrl: String(body.certificateUrl || '').trim(),
          sortOrder: Number(body.sortOrder || 0),
        })
        .where(eq(experienceEducation.id, id))
        .returning();
      if (!updated.length) return res.status(404).json({ error: 'Entry not found.' });
      res.json(updated[0]);
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to update timeline entry.' });
    }
  });

  app.delete('/api/admin/experience/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID.' });
    try {
      await db.delete(experienceEducation).where(eq(experienceEducation.id, id));
      res.json({ deleted: true });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to delete timeline entry.' });
    }
  });

  // Admin Skills CRUD
  app.post('/api/admin/skills', requireAdmin, async (req, res) => {
    try {
      const { category, name, description, sortOrder } = req.body ?? {};
      if (!isSafeString(category, 80) || !isSafeString(name, 100) || !isSafeString(description, 500)) {
        return res.status(400).json({ error: 'Category, name, and description are required.' });
      }
      const created = await db
        .insert(skills)
        .values({
          category: category.trim(),
          name: name.trim(),
          description: description.trim(),
          sortOrder: Number(sortOrder || 20),
        })
        .returning();
      res.status(201).json(created[0]);
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to add skill.' });
    }
  });

  app.delete('/api/admin/skills/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID.' });
    try {
      await db.delete(skills).where(eq(skills.id, id));
      res.json({ deleted: true });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to delete skill.' });
    }
  });

  // Admin Contact Submissions Management
  app.get('/api/admin/contacts', requireAdmin, async (_req, res) => {
    try {
      const rows = await db
        .select()
        .from(contactSubmissions)
        .orderBy(desc(contactSubmissions.createdAt));
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to load enquiries.' });
    }
  });

  app.put('/api/admin/contacts/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID.' });
    try {
      const { status, notes } = req.body ?? {};
      const allowedStatuses = new Set(['New', 'In Review', 'Replied', 'Archived']);
      const safeStatus = allowedStatuses.has(status) ? status : 'In Review';
      const updated = await db
        .update(contactSubmissions)
        .set({
          status: safeStatus,
          notes: isOptionalSafeString(notes, 2000) ? notes.trim() : '',
        })
        .where(eq(contactSubmissions.id, id))
        .returning();
      if (!updated.length) return res.status(404).json({ error: 'Enquiry not found.' });
      res.json(updated[0]);
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to update enquiry.' });
    }
  });

  app.delete('/api/admin/contacts/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID.' });
    try {
      await db.delete(contactSubmissions).where(eq(contactSubmissions.id, id));
      res.json({ deleted: true });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to delete enquiry.' });
    }
  });

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server error:', err);
  process.exit(1);
});
