export interface PdsHint {
    strategy?: 'override' | 'default';
    fleet?: string[];
}
export interface FleetMember {
    localPath: string;
    npm: string;
    subdir?: string;
    github?: string;
    gitlab?: string;
}
export interface FleetDetection {
    members: FleetMember[];
    strategy: 'override' | 'default';
    fromHint: boolean;
}
export declare function readPdsHint(root: string): PdsHint | null;
export declare function listWorkspacePackages(root: string): {
    dir: string;
    name: string;
    private: boolean;
}[];
export declare function detectFleet(initPath: string): FleetDetection | null;
//# sourceMappingURL=fleet.d.ts.map