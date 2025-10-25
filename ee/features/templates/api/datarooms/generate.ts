import type { NextApiRequest, NextApiResponse } from "next";

import {
  DATAROOM_TEMPLATES,
  FolderTemplate,
} from "@/ee/features/templates/constants/dataroom-templates";
import { generateDataroomSchema } from "@/ee/features/templates/schemas/dataroom-templates";
import { getLimits } from "@/ee/limits/server";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import slugify from "@sindresorhus/slugify";
import { getServerSession } from "next-auth/next";

import { newId } from "@/lib/id-helper";
import prisma from "@/lib/prisma";
import { CustomUser } from "@/lib/types";

export default async function handle(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method === "POST") {
    // POST /api/teams/:teamId/datarooms/generate
    const session = await getServerSession(req, res, authOptions);
    if (!session) {
      res.status(401).end("Unauthorized");
      return;
    }

    const userId = (session.user as CustomUser).id;

    const { teamId } = req.query as { teamId: string };

    // Validate request body using Zod schema for SSRF protection
    const validationResult = generateDataroomSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        message: "Invalid dataroom type. Please select a valid type.",
        errors: validationResult.error.flatten().fieldErrors,
      });
    }

    const { name, type } = validationResult.data;

    try {
      // Check if the user is part of the team
      const team = await prisma.team.findUnique({
        where: {
          id: teamId,
          plan: {
            // exclude all teams not on `business`, `datarooms`, `datarooms-plus`, `business+old`, `datarooms+old`, `datarooms-plus+old` plan
            in: [
              "business",
              "datarooms",
              "datarooms-plus",
              "business+old",
              "datarooms+old",
              "datarooms-plus+old",
              "datarooms+drtrial",
              "business+drtrial",
              "datarooms-plus+drtrial",
            ],
          },
          users: {
            some: {
              userId: userId,
            },
          },
        },
      });

      if (!team) {
        return res.status(401).end("Unauthorized");
      }

      // Limits: Check if the user has reached the limit of datarooms in the team
      const dataroomCount = await prisma.dataroom.count({
        where: {
          teamId: teamId,
        },
      });

      const limits = await getLimits({ teamId, userId });

      if (limits && dataroomCount >= limits.datarooms) {
        return res
          .status(403)
          .json({ message: "You have reached the limit of datarooms" });
      }

      const pId = newId("dataroom");

      // Create folders based on the selected template
      const template = DATAROOM_TEMPLATES[type];

      // Use template name + "Data Room" if no name is provided
      const dataroomName = name?.trim() || `${template.name} Data Room`;

      // Create the dataroom and folders in a transaction to prevent hanging results
      const dataroom = await prisma.$transaction(async (tx) => {
        // Create the dataroom
        const createdDataroom = await tx.dataroom.create({
          data: {
            name: dataroomName,
            teamId: teamId,
            pId: pId,
          },
        });

        // Helper function to create folders recursively
        const createFolders = async (
          folders: FolderTemplate[],
          parentPath: string = "",
          parentId: string | null = null,
        ): Promise<void> => {
          for (const folder of folders) {
            const folderPath = parentPath + "/" + slugify(folder.name);

            // Create the folder
            const createdFolder = await tx.dataroomFolder.create({
              data: {
                name: folder.name,
                path: folderPath,
                parentId: parentId,
                dataroomId: createdDataroom.id,
              },
            });

            // If the folder has subfolders, create them recursively
            if (folder.subfolders && folder.subfolders.length > 0) {
              await createFolders(
                folder.subfolders,
                folderPath,
                createdFolder.id,
              );
            }
          }
        };

        await createFolders(template.folders);

        return createdDataroom;
      });

      const dataroomWithCount = {
        ...dataroom,
        _count: { documents: 0 },
      };

      res.status(201).json({
        dataroom: dataroomWithCount,
        message: "Dataroom generated successfully",
      });
    } catch (error) {
      console.error("Error generating dataroom:", error);
      return res.status(500).json({ error: "Error generating dataroom" });
    }
  } else {
    // We only allow POST requests
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
